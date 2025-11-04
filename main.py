import os
import json
import logging
import time
import re
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
from urllib.parse import urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import unicodedata

import yaml
from firecrawl import FirecrawlApp
import requests

OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/data"))
LOG_PATH = Path(os.environ.get("LOG_PATH", "/logs/firecrawl.log"))
CONFIG_PATH = os.environ.get("CONFIG_PATH", "/app/config.yaml")

FIRECRAWL_URL = os.environ.get("FIRECRAWL_URL", "http://api:3002")
SCHEDULE_HOURS = float(os.environ.get("SCHEDULE_HOURS", "24"))
RUN_ONCE = os.environ.get("RUN_ONCE", "false").lower() == "true"

META_JSONL = OUTPUT_DIR / "metadata.jsonl"
META_JSON = OUTPUT_DIR / "metadata.json"
CRAWLED_CACHE = OUTPUT_DIR / "crawled_urls.txt"
CHECKPOINT_FILE = OUTPUT_DIR / "checkpoint.json"
FAILED_URLS_FILE = OUTPUT_DIR / "failed_urls.jsonl"
STATS_FILE = OUTPUT_DIR / "crawl_stats.json"

# Cache for numbered document URLs mapping
NUMBERED_DOCS_CACHE = {}
# In-memory cache mirroring the file-backed crawled URLs cache. This is
# used to avoid re-processing URLs discovered/saved during the same run.
CRAWLED_URLS_SET = set()

LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("firecrawl-uit")


class CrawlStats:
    """Track crawl statistics and performance metrics"""
    
    def __init__(self):
        self.total_pages = 0
        self.success_count = 0
        self.error_count = 0
        self.skipped_count = 0
        self.total_size_bytes = 0
        self.start_time = datetime.now()
        self.seed_stats = {}
        self.error_categories = {}
    
    def add_page(self, seed_url: str, size_bytes: int = 0, success: bool = True):
        """Record a page crawl"""
        self.total_pages += 1
        if success:
            self.success_count += 1
        else:
            self.error_count += 1
        
        self.total_size_bytes += size_bytes
        
        if seed_url not in self.seed_stats:
            self.seed_stats[seed_url] = {
                "pages": 0,
                "size_mb": 0,
                "errors": 0
            }
        
        self.seed_stats[seed_url]["pages"] += 1
        self.seed_stats[seed_url]["size_mb"] += size_bytes / (1024**2)
        if not success:
            self.seed_stats[seed_url]["errors"] += 1
    
    def add_skipped(self):
        """Record a skipped page (cached)"""
        self.skipped_count += 1
    
    def add_error(self, category: str):
        """Record an error by category"""
        self.error_count += 1
        self.error_categories[category] = self.error_categories.get(category, 0) + 1
    
    def get_report(self) -> dict:
        """Generate comprehensive statistics report"""
        duration = (datetime.now() - self.start_time).total_seconds()
        
        return {
            "summary": {
                "total_pages": self.total_pages,
                "success_count": self.success_count,
                "error_count": self.error_count,
                "skipped_count": self.skipped_count,
                "success_rate": round(self.success_count / max(self.total_pages, 1) * 100, 2),
                "total_size_mb": round(self.total_size_bytes / (1024**2), 2),
            },
            "performance": {
                "duration_seconds": round(duration, 2),
                "duration_minutes": round(duration / 60, 2),
                "pages_per_minute": round(self.total_pages / max(duration / 60, 1), 2),
                "mb_per_minute": round((self.total_size_bytes / (1024**2)) / max(duration / 60, 1), 2),
            },
            "seeds": self.seed_stats,
            "errors_by_category": self.error_categories,
            "timestamp": datetime.now().isoformat()
        }
    
    def save_report(self):
        """Save statistics to file"""
        report = self.get_report()
        with open(STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        logger.info(f"Statistics saved to {STATS_FILE}")

# Global stats instance
crawl_stats = CrawlStats()


def save_checkpoint(seed_url: str, seed_index: int):
    """Save checkpoint for recovery"""
    checkpoint = {
        "seed_url": seed_url,
        "seed_index": seed_index,
        "timestamp": datetime.now().isoformat(),
        "stats": crawl_stats.get_report()
    }
    with open(CHECKPOINT_FILE, "w", encoding="utf-8") as f:
        json.dump(checkpoint, f, ensure_ascii=False, indent=2)

def load_checkpoint() -> Optional[dict]:
    """Load checkpoint to resume from interruption"""
    if CHECKPOINT_FILE.exists():
        try:
            with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
                checkpoint = json.load(f)
                logger.info(f"Found checkpoint: {checkpoint['seed_url']} at {checkpoint['timestamp']}")
                return checkpoint
        except Exception as e:
            logger.warning(f"Failed to load checkpoint: {e}")
    return None

def clear_checkpoint():
    """Clear checkpoint after successful completion"""
    if CHECKPOINT_FILE.exists():
        CHECKPOINT_FILE.unlink()
        logger.info("Checkpoint cleared")

def mark_failed_url(url: str, error: str, seed_url: str, attempts: int = 3):
    """Record failed URL for later retry"""
    with open(FAILED_URLS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "url": url,
            "seed_url": seed_url,
            "error": str(error)[:200],  # Truncate long errors
            "attempts": attempts,
            "timestamp": datetime.now().isoformat()
        }, ensure_ascii=False) + "\n")

def categorize_error(exception: Exception) -> str:
    """Categorize error type for better debugging"""
    error_str = str(exception).lower()
    
    if "timeout" in error_str:
        return "timeout"
    elif any(x in error_str for x in ["403", "401", "unauthorized"]):
        return "permission_denied"
    elif "404" in error_str:
        return "not_found"
    elif any(x in error_str for x in ["500", "502", "503"]):
        return "server_error"
    elif any(x in error_str for x in ["connection", "network"]):
        return "network_error"
    
    return "unknown"


def wait_for_firecrawl(max_retries: int = 30, delay: int = 10) -> bool:
    """Wait for Firecrawl API to be ready with health checks"""
    logger.info("Waiting for Firecrawl services to start...")
    
    for i in range(max_retries):
        try:
            logger.info(f"Attempting health check {i+1}/{max_retries} to {FIRECRAWL_URL}/v1")
            response = requests.get(f"{FIRECRAWL_URL}/v1", timeout=5)
            logger.info(f"Got response status: {response.status_code}")
            if response.status_code in [200, 404]:
                logger.info(f"Connected to Firecrawl at {FIRECRAWL_URL}")
                return True
            else:
                logger.warning(f"Unexpected status code: {response.status_code}, retrying...")
        except requests.exceptions.RequestException as e:
            logger.info(f"RequestException: {type(e).__name__}: {str(e)[:100]}")
            if i < max_retries - 1:
                logger.warning(f"Firecrawl not ready yet ({i+1}/{max_retries}), waiting {delay}s...")
                time.sleep(delay)
            else:
                logger.error(f"Failed to connect to Firecrawl after {max_retries} attempts: {e}")
                return False
        except Exception as e:
            logger.error(f"Unexpected error during health check: {type(e).__name__}: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return False
    
    return False

def slugify_vietnamese(text: str) -> str:
    """
    Convert Vietnamese text with diacritics to lowercase ASCII with hyphens.
    Example: "Quyết định về việc" -> "quyet-dinh-ve-viec"
    """
    # Vietnamese character mapping
    vietnamese_map = {
        'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
        'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
        'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
        'đ': 'd',
        'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
        'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
        'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
        'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
        'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
        'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
        'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
        'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
        'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
        'À': 'A', 'Á': 'A', 'Ả': 'A', 'Ã': 'A', 'Ạ': 'A',
        'Ă': 'A', 'Ằ': 'A', 'Ắ': 'A', 'Ẳ': 'A', 'Ẵ': 'A', 'Ặ': 'A',
        'Â': 'A', 'Ầ': 'A', 'Ấ': 'A', 'Ẩ': 'A', 'Ẫ': 'A', 'Ậ': 'A',
        'Đ': 'D',
        'È': 'E', 'É': 'E', 'Ẻ': 'E', 'Ẽ': 'E', 'Ẹ': 'E',
        'Ê': 'E', 'Ề': 'E', 'Ế': 'E', 'Ể': 'E', 'Ễ': 'E', 'Ệ': 'E',
        'Ì': 'I', 'Í': 'I', 'Ỉ': 'I', 'Ĩ': 'I', 'Ị': 'I',
        'Ò': 'O', 'Ó': 'O', 'Ỏ': 'O', 'Õ': 'O', 'Ọ': 'O',
        'Ô': 'O', 'Ồ': 'O', 'Ố': 'O', 'Ổ': 'O', 'Ỗ': 'O', 'Ộ': 'O',
        'Ơ': 'O', 'Ờ': 'O', 'Ớ': 'O', 'Ở': 'O', 'Ỡ': 'O', 'Ợ': 'O',
        'Ù': 'U', 'Ú': 'U', 'Ủ': 'U', 'Ũ': 'U', 'Ụ': 'U',
        'Ư': 'U', 'Ừ': 'U', 'Ứ': 'U', 'Ử': 'U', 'Ữ': 'U', 'Ự': 'U',
        'Ỳ': 'Y', 'Ý': 'Y', 'Ỷ': 'Y', 'Ỹ': 'Y', 'Ỵ': 'Y',
    }
    
    # Replace Vietnamese characters
    result = ''.join(vietnamese_map.get(c, c) for c in text)
    
    # Convert to lowercase
    result = result.lower()
    
    # Replace spaces and special characters with hyphens
    result = re.sub(r'[^\w\s-]', '', result)  # Remove special chars except space and hyphen
    result = re.sub(r'[-\s]+', '-', result)   # Replace spaces and multiple hyphens with single hyphen
    result = result.strip('-')                # Remove leading/trailing hyphens
    
    return result

def load_config() -> Dict[str, Any]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    
    def env_list(name: str, default: List[str]) -> List[str]:
        raw = os.environ.get(name)
        if raw is None or raw.strip() == "":
            return default
        return [x.strip() for x in raw.split(",") if x.strip()]
    
    cfg["seed_urls"] = env_list("SEED_URLS", cfg.get("seed_urls", []))
    cfg["include_patterns"] = env_list("INCLUDE_PATTERNS", cfg.get("include_patterns", []))
    cfg["exclude_patterns"] = env_list("EXCLUDE_PATTERNS", cfg.get("exclude_patterns", []))
    cfg["max_depth"] = int(os.environ.get("MAX_DEPTH", cfg.get("max_depth", 3)))
    
    return cfg

def ensure_dirs():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def load_crawled_urls() -> set:
    if CRAWLED_CACHE.exists():
        with open(CRAWLED_CACHE, "r", encoding="utf-8") as f:
            return set(line.strip() for line in f if line.strip())
    return set()

def mark_url_crawled(url: str):
    """Mark URL as crawled in cache"""
    try:
        with open(CRAWLED_CACHE, "a", encoding="utf-8") as f:
            f.write(url + "\n")
    except Exception:
        # Best effort write; don't crash the whole crawler if disk write fails
        logger.warning(f"Failed to write crawled URL to cache file: {url}")

    # Keep the in-memory set in sync so the running process doesn't
    # re-process URLs that were just saved.
    try:
        CRAWLED_URLS_SET.add(url)
    except Exception:
        logger.debug(f"Failed to add URL to in-memory crawled set: {url}")

def log_crawled_file(local_path: Path, source_url: str):
    """
    Log crawled file to crawled.txt with format:
    <local_path> - url: <source_url>
    """
    crawled_log = OUTPUT_DIR / "crawled.txt"
    relative_path = local_path.relative_to(OUTPUT_DIR)
    
    with open(crawled_log, "a", encoding="utf-8") as f:
        f.write(f"{relative_path} - url: {source_url}\n")

def should_recrawl(url: str, days_threshold: int = 7) -> bool:
    """Determine if URL should be recrawled (incremental crawling)"""
    if url not in load_crawled_urls():
        return True
    
    # Check if metadata exists and get last crawl date
    if META_JSON.exists():
        try:
            with open(META_JSON, "r", encoding="utf-8") as f:
                items = json.load(f)
                for item in items:
                    if item.get("url") == url:
                        last_crawl = item.get("date")
                        if last_crawl:
                            crawl_date = datetime.fromisoformat(last_crawl)
                            days_since = (datetime.now() - crawl_date).days
                            if days_since > days_threshold:
                                logger.info(f"Recrawling old URL ({days_since} days): {url}")
                                return True
                        break
        except Exception as e:
            logger.warning(f"Error checking recrawl status: {e}")
    
    return False

CURRENT_SEED_URL = None

def get_content_folder(url: str, title: str = "") -> str:
    """Map URL to folder structure based on new requirements"""
    text = (url + " " + title).lower()
    
    # Giới thiệu
    if any(x in text for x in ["cong-thong-tin-dao-tao", "content/cong-thong-tin"]):
        return "daa/gioithieu/cong-thong-tin-dao-tao"
    elif any(x in text for x in ["nganh-dao-tao", "tuyensinh.uit.edu.vn/nganh"]):
        return "daa/gioithieu/nganh-dao-tao"
    elif any(x in text for x in ["chuc-nang-nhiem-vu"]):
        return "daa/gioithieu/chuc-nang-nhiem-vu"
    
    # Quy định - Hướng dẫn (CHECK BEFORE "Thông báo" to avoid false positives from /thongbao/huong-dan-*)
    elif any(x in text for x in ["qui-che-qui-dinh-qui-trinh", "quy-che-quy-dinh-quy-trinh"]):
        return "daa/quydinh_huongdan/qui-che-qui-dinh-qui-trinh"
    elif any(x in text for x in ["quy-che-quy-dinh-dao-tao-dai-hoc-cua-dhqg-hcm", "dhqg-hcm"]):
        return "daa/quydinh_huongdan/quyche-dhqg-hcm"
    elif any(x in text for x in ["quy-che-quy-dinh-dao-tao-dai-hoc-cua-bo-gddt", "bo-gddt"]):
        return "daa/quydinh_huongdan/quyche-bogddt"
    elif any(x in text for x in ["quy-dinh-giao-trinh", "53_qd_dhcntt"]):
        return "daa/quydinh_huongdan/quy-dinh-giao-trinh"
    elif any(x in text for x in ["quy-dinh-dao-tao-ngan-han", "dao-tao-ngan-han"]):
        return "daa/quydinh_huongdan/quy-dinh-dao-tao-ngan-han"
    elif any(x in text for x in ["quy-trinh-danh-cho-can-bo-giang-day", "can-bo-giang-day"]):
        return "daa/quydinh_huongdan/quy-trinh-can-bo-giang-day"
    elif any(x in text for x in ["quy-trinh-danh-cho-sinh-vien", "mot-so-quy-trinh-danh-cho-sinh-vien"]):
        return "daa/quydinh_huongdan/quy-trinh-sinh-vien"
    elif any(x in text for x in ["huong-dan-tra-cuu-va-xac-minh-van-bang", "tra-cuu-van-bang"]):
        return "daa/quydinh_huongdan/huong-dan-tra-cuu-van-bang"
    elif any(x in text for x in ["huong-dan-sinh-vien-dai-hoc-he-chinh-quy", "chuan-qua-trinh"]):
        return "daa/quydinh_huongdan/huong-dan-chuan-qua-trinh"
    elif any(x in text for x in ["huong-dan-trien-khai-day-va-hoc-qua-mang", "day-va-hoc-online", "covid"]):
        return "daa/quydinh_huongdan/huong-dan-day-va-hoc-online"
    
    # Thông báo (checked AFTER hướng dẫn)
    elif any(x in text for x in ["thongbaochinhquy", "thongbao-chinhquy"]):
        return "daa/thongbao/thongbao-chinhquy"
    elif any(x in text for x in ["thong-bao-vb2", "thongbao-vb2"]):
        return "daa/thongbao/thongbao-vb2"
    elif any(x in text for x in ["thongbaotuxa", "thongbao-tuxa"]):
        return "daa/thongbao/thongbao-tuxa"
    
    # Kế hoạch năm
    elif any(x in text for x in ["kehoachnam", "ke-hoach-nam"]):
        return "daa/kehoachnam"
    
    # Chương trình đào tạo - Hệ chính quy
    elif "/cqui/" in text or "ctdt-khoa-" in text and "chinh-quy" in text:
        # Extract year from URL
        for year in range(2012, 2026):
            if f"khoa-{year}" in text:
                return f"daa/chuongtrinh_daotao/he-chinhquy/khoa-{year}"
        return "daa/chuongtrinh_daotao/he-chinhquy/khac"
    elif any(x in text for x in ["chuong-trinh-dao-tao-cu", "ctdt-cu"]):
        return "daa/chuongtrinh_daotao/he-chinhquy/ctdt-cu"
    elif any(x in text for x in ["danh-muc-mon-hoc-dai-hoc", "danh-muc-mon-hoc"]):
        return "daa/chuongtrinh_daotao/he-chinhquy/danh-muc-mon-hoc"
    elif any(x in text for x in ["bang-tom-tat-mon-hoc", "tom-tat-mon-hoc"]):
        return "daa/chuongtrinh_daotao/he-chinhquy/bang-tom-tat-mon-hoc"
    
    # Chương trình đào tạo - Hệ từ xa
    elif "/tu-xa/" in text or "tuxa" in text:
        # Extract year from URL
        for year in range(2008, 2025):
            if f"khoa-{year}" in text:
                return f"daa/chuongtrinh_daotao/he-tuxa/khoa-{year}"
        return "daa/chuongtrinh_daotao/he-tuxa/khac"
    
    # Đề án mở ngành
    elif any(x in text for x in ["de-mo-nganh", "loai-bai-viet/de-mo-nganh"]):
        return "daa/de-mo-nganh"
    
    else:
        return "daa/khac/chua-phan-loai"

def append_jsonl(obj: Dict[str, Any]):
    with open(META_JSONL, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")

def rebuild_metadata_json():
    items = []
    if META_JSONL.exists():
        with open(META_JSONL, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    items.append(json.loads(line))
                except Exception as e:
                    logger.warning(f"Failed to parse JSON line: {e}")
    
    with open(META_JSON, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

def find_download_links(html: str, base_url: str) -> List[str]:
    if not html:
        return []
    
    links = []
    patterns = [
        r'href=["\']([^"\']*\.pdf[^"\']*)["\']',
        r'href=["\']([^"\']*\.docx?[^"\']*)["\']',
        r'href=["\']([^"\']*\.xlsx?[^"\']*)["\']',
    ]
    
    for pattern in patterns:
        matches = re.findall(pattern, html, re.IGNORECASE)
        for match in matches:
            full_url = urljoin(base_url, match)
            if full_url not in links:
                links.append(full_url)
    
    return links

def download_file(url: str, output_dir: Path, category: str = "files") -> bool:
    try:
        parsed = urlparse(url)
        filename = parsed.path.split('/')[-1]
        if not filename or len(filename) > 200:
            url_hash = hashlib.sha1(url.encode()).hexdigest()[:8]
            ext = url.split('.')[-1].lower() if '.' in url else 'bin'
            filename = f"{url_hash}.{ext}"
        
        output_path = output_dir / filename
        
        if output_path.exists():
            logger.debug(f"File already exists: {filename}")
            return True
        
        response = requests.get(url, stream=True, timeout=30, verify=False)
        response.raise_for_status()
        
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        size_mb = output_path.stat().st_size / (1024 * 1024)
        logger.info(f"Downloaded [{category}]: {filename} ({size_mb:.2f} MB)")
        
        # Log to crawled.txt
        log_crawled_file(output_path, url)
        
        metadata = {
            "title": filename,
            "url": url,
            "type": "file",
            "seed": CURRENT_SEED_URL if CURRENT_SEED_URL else "unknown",
            "seed_folder": category,
            "file_path": str(output_path),
            "size_mb": round(size_mb, 2),
            "date": datetime.now().isoformat(),
        }
        append_jsonl(metadata)
        
        return True
    
    except Exception as e:
        logger.warning(f"Failed to download {url}: {e}")
        return False

def extract_numbered_title(title: str, content: str = "") -> Optional[tuple]:
    """
    Extract numbered document information from title or content.
    Returns (number, full_title) or None.
    
    Example:
        "01. Quyết định về việc ban hành..." -> ("01", "Quyết định về việc ban hành...")
        "02. Quy định về đánh giá..." -> ("02", "Quy định về đánh giá...")
    
    Note: Keeps the full Vietnamese title with original formatting.
    """
    # Try to find pattern like "01.", "02.", etc. at the beginning
    pattern = r'^(\d{1,3})[\.\)]\s*(.+?)(?:\s*$)'
    
    # Search in title first
    match = re.search(pattern, title.strip(), re.MULTILINE)
    if not match:
        # Try to find in content (first few lines)
        first_lines = content[:1000] if content else ""
        match = re.search(pattern, first_lines, re.MULTILINE)
    
    if match:
        number = match.group(1).zfill(2)  # Pad to 2 digits: "1" -> "01"
        doc_title = match.group(2).strip()
        
        # Clean up excessive whitespace but keep Vietnamese characters
        doc_title = re.sub(r'\s+', ' ', doc_title)
        # Remove any trailing punctuation
        doc_title = doc_title.rstrip('.,;:')
        # Limit length
        doc_title = doc_title[:200]
        
        return (number, doc_title)
    
    return None

def get_nhom_lon(url: str, title: str) -> str:
    """
    Determine the main category group (nhom_lon) for quydinh_huongdan.
    
    Categories:
    - qui-che-qui-dinh-qui-trinh: Official regulations and procedures
    - huong-dan-sinh-vien: Student guidance documents
    - bieumau-bangbieucuahang: Forms and templates
    
    Returns the category slug or default.
    """
    text = (url + " " + title).lower()
    
    # Check for forms/templates
    if any(x in text for x in ["biểu mẫu", "bieu-mau", "bảng biểu", "bang-bieu", "mẫu đơn"]):
        return "bieumau-bangbieucuahang"
    
    # Check for student guidance
    if any(x in text for x in ["hướng dẫn sinh viên", "huong-dan-sinh-vien", 
                                "đăng ký", "dang-ky", "tốt nghiệp", "tot-nghiep",
                                "học vụ", "hoc-vu"]):
        return "huong-dan-sinh-vien"
    
    # Default to qui-che-qui-dinh-qui-trinh (most common)
    return "qui-che-qui-dinh-qui-trinh"

def parse_numbered_list_from_html(html: str, base_url: str) -> List[str]:
    """
    Parse numbered document list from HTML content.
    Returns list of detail URLs found in this listing page.
    Also caches URL metadata in NUMBERED_DOCS_CACHE.
    
    Example HTML patterns:
    <a href="/content/123">01. Quyết định về việc...</a>
    <a href="/content/123">1) Quyết định về việc...</a>
    """
    global NUMBERED_DOCS_CACHE
    
    if not html:
        return []
    
    # Pattern to find numbered links like "01. Title" or "1) Title"
    # Match: <a href="...">01. Quyết định...</a>
    # Also match with optional whitespace and newlines
    pattern = r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>\s*(\d{1,3})[\.\)]\s*([^<]+)</a>'
    
    matches = re.findall(pattern, html, re.IGNORECASE | re.DOTALL)
    
    if matches:
        logger.info(f"Found {len(matches)} potential numbered items in {base_url}")
    
    found_urls = []
    seen_urls = set()  # Avoid duplicates
    
    for href, number, title_text in matches:
        # Build full URL
        full_url = urljoin(base_url, href)
        
        # Skip if already processed in this page
        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)
        
        # Clean title - handle HTML entities and excessive whitespace
        title_clean = title_text.strip()
        title_clean = re.sub(r'\s+', ' ', title_clean)
        title_clean = title_clean.rstrip('.,;:')[:200]
        
        # Skip if title is too short (likely garbage)
        if len(title_clean) < 5:
            continue
        
        # Pad number
        number_padded = number.zfill(2)
        
        # Determine nhom_lon from base_url
        nhom_lon = get_nhom_lon(base_url, title_text)
        
        # Store in cache
        NUMBERED_DOCS_CACHE[full_url] = (number_padded, title_clean, nhom_lon)
        found_urls.append(full_url)
        logger.info(f"Cached numbered doc: {full_url} -> {number_padded}. {title_clean}")
    
    if found_urls:
        logger.info(f"Successfully cached {len(found_urls)} numbered docs from {base_url}")
    
    return found_urls

def parse_de_mo_nganh_list_from_html(html: str, base_url: str) -> List[str]:
    """
    Parse "đề án mở ngành" (project proposal) list from HTML content.
    Similar to numbered docs, extracts detail links but without strict numbering requirement.
    Returns list of detail URLs found in this listing page.
    
    Pattern: <a href="/...">Tên đề án...</a> or similar article links
    """
    if not html:
        return []
    
    # For de-mo-nganh, we look for article/content links (similar to regulations listing)
    # Pattern: <a href="...">Article Title</a> with title > 10 chars
    # Also find links to actual content pages (not just navigation)
    pattern = r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([^<]+)</a>'
    
    matches = re.findall(pattern, html, re.IGNORECASE)
    
    found_urls = []
    seen_urls = set()
    
    for href, title_text in matches:
        # Build full URL
        full_url = urljoin(base_url, href)
        
        # Skip navigation/footer links
        skip_keywords = ["sidebar", "footer", "menu", "skip", "home", "back", "login", "search", "tag"]
        if any(kw in full_url.lower() for kw in skip_keywords):
            continue
        
        # Skip if already processed
        if full_url in seen_urls:
            continue
        
        # Skip if URL is same as base (listing page itself)
        if full_url == base_url.rstrip('/'):
            continue
        
        seen_urls.add(full_url)
        
        # Clean and filter title
        title_clean = title_text.strip()
        title_clean = re.sub(r'\s+', ' ', title_clean)
        title_clean = title_clean.rstrip('.,;:')[:200]
        
        # Only include links with meaningful titles (> 10 chars)
        if len(title_clean) < 10:
            continue
        
        # Check if URL looks like a detail page (contains content/article keywords)
        if any(keyword in full_url.lower() for keyword in ["content", "node", "de-mo-nganh", "/2024/", "/2025/"]):
            found_urls.append(full_url)
            logger.info(f"Cached de-mo-nganh detail: {full_url} -> {title_clean}")
    
    if found_urls:
        logger.info(f"Found {len(found_urls)} de-mo-nganh detail pages from {base_url}")
    
    return found_urls

def trim_markdown_content(markdown: str) -> str:
    """Trim markdown to main content only: remove navigation, skip-to links, and summarize large tables"""
    if not markdown:
        return markdown
    
    lines = markdown.split('\n')
    trimmed_lines = []
    in_table = False
    table_lines = []
    skip_related_section = False
    
    for line in lines:
        stripped = line.strip()
        
        # Skip empty lines at the beginning
        if not trimmed_lines and not stripped:
            continue
        
        # Skip navigation/skip-to links (including variations)
        if stripped.lower().startswith('[skip'):
            continue
        if any(kw in stripped.lower() for kw in ["skip to", "skip navigation", "skip link"]):
            continue
        
        # Skip related information sections
        if any(kw in stripped.lower() for kw in ["related information", "thông tin liên quan", "liên quan", "related link"]):
            skip_related_section = True
            continue
        
        # End related section when we hit next heading or content
        if skip_related_section and stripped and stripped.startswith('#'):
            skip_related_section = False
        elif skip_related_section:
            continue
        
        # Detect table start (markdown table lines start with |)
        if '|' in line and not in_table:
            in_table = True
            table_lines = [line]
        elif in_table:
            if '|' in line:
                table_lines.append(line)
            else:
                # Table ended, decide whether to include it
                in_table = False
                # Include table only if not too large (> 30 rows = skip/summarize)
                if len(table_lines) <= 30:
                    trimmed_lines.extend(table_lines)
                else:
                    # For large tables, add a summary and skip inline content
                    col_count = len([c for c in table_lines[0].split('|') if c.strip()])
                    trimmed_lines.append(f"_[Bảng lớn: {len(table_lines)} dòng, {col_count} cột - bỏ qua để tiết kiệm dung lượng]_\n")
                table_lines = []
                # Add the non-table line that ended this table
                if stripped:
                    trimmed_lines.append(line)
        else:
            trimmed_lines.append(line)
    
    # Handle table at end of file
    if in_table and table_lines:
        if len(table_lines) <= 30:
            trimmed_lines.extend(table_lines)
        else:
            col_count = len([c for c in table_lines[0].split('|') if c.strip()])
            trimmed_lines.append(f"_[Bảng lớn: {len(table_lines)} dòng, {col_count} cột - bỏ qua để tiết kiệm dung lượng]_")
    
    result = '\n'.join(trimmed_lines)
    # Clean up excessive newlines (more than 3 in a row)
    while '\n\n\n\n' in result:
        result = result.replace('\n\n\n\n', '\n\n\n')
    
    return result.strip()

def save_content(url: str, data: Dict[str, Any]):
    global CURRENT_SEED_URL, NUMBERED_DOCS_CACHE
    
    title = data.get("metadata", {}).get("title", "")
    content_folder = get_content_folder(url, title)
    
    mark_url_crawled(url)
    
    html_content = data.get("html", "")
    
    # Check if this URL is in the numbered docs cache (from listing page)
    numbered_info = None
    if url in NUMBERED_DOCS_CACHE:
        number, doc_title, nhom_lon = NUMBERED_DOCS_CACHE[url]
        # Use slugified title (no diacritics, with hyphens)
        doc_title_slug = slugify_vietnamese(doc_title)
        numbered_folder = f"{number}-{doc_title_slug}"
        content_folder = f"daa/quydinh_huongdan/{nhom_lon}/{numbered_folder}"
        numbered_info = (number, doc_title)
        logger.info(f"Using cached numbered doc: {numbered_folder} in {nhom_lon}")
    
    # Otherwise, try to detect from current page content
    elif "quydinh_huongdan" in content_folder:
        markdown_content = data.get("markdown", "")
        content_text = markdown_content or html_content
        
        numbered_info = extract_numbered_title(title, content_text)
        if numbered_info:
            number, doc_title = numbered_info
            # Determine nhom_lon (main category group)
            nhom_lon = get_nhom_lon(url, title)
            # Use slugified title (no diacritics, with hyphens)
            doc_title_slug = slugify_vietnamese(doc_title)
            numbered_folder = f"{number}-{doc_title_slug}"
            content_folder = f"daa/quydinh_huongdan/{nhom_lon}/{numbered_folder}"
            logger.info(f"Detected numbered document: {numbered_folder} in {nhom_lon}")
    
    content_dir = OUTPUT_DIR / content_folder
    
    # For quydinh_huongdan with numbered docs, save directly in the folder (no html/pdf subfolders)
    if numbered_info and "quydinh_huongdan" in content_folder:
        # Files go directly in the numbered folder
        content_dir.mkdir(parents=True, exist_ok=True)
        html_dir = content_dir
        markdown_dir = content_dir
        pdf_dir = content_dir
        docx_dir = content_dir
    else:
        # For other categories, use traditional structure with subfolders
        html_dir = content_dir / "html"
        markdown_dir = content_dir / "markdown"
        pdf_dir = content_dir / "pdf"
        docx_dir = content_dir / "docx"
        
        html_dir.mkdir(parents=True, exist_ok=True)
        markdown_dir.mkdir(parents=True, exist_ok=True)
        pdf_dir.mkdir(parents=True, exist_ok=True)
        docx_dir.mkdir(parents=True, exist_ok=True)
    
    safe_name = url.replace("https://", "").replace("http://", "")
    safe_name = safe_name.replace("/", "_").replace(":", "_")[:200]
    
    total_size = 0
    
    if data.get("html"):
        html_file = html_dir / f"{safe_name}.html"
        with open(html_file, "w", encoding="utf-8") as f:
            f.write(data["html"])
        total_size += html_file.stat().st_size
        logger.info(f"Saved HTML [{content_folder}]: {html_file.name}")
        # Don't log HTML to crawled.txt (only MD and PDF)
        
        download_links = find_download_links(data["html"], url)
        for link in download_links:
            if link.lower().endswith('.pdf'):
                download_file(link, pdf_dir, content_folder)
            elif link.lower().endswith(('.doc', '.docx')):
                download_file(link, docx_dir, content_folder)
    
    if data.get("markdown"):
        md_file = markdown_dir / f"{safe_name}.md"
        markdown_content = data["markdown"]
        # Trim markdown to main content only
        markdown_content = trim_markdown_content(markdown_content)
        with open(md_file, "w", encoding="utf-8") as f:
            f.write(markdown_content)
        total_size += md_file.stat().st_size
        logger.info(f"Saved Markdown [{content_folder}]: {md_file.name}")
        log_crawled_file(md_file, url)  # Log to crawled.txt
    
    # Update stats
    if CURRENT_SEED_URL:
        crawl_stats.add_page(CURRENT_SEED_URL, total_size, success=True)
    
    metadata = {
        "title": data.get("metadata", {}).get("title", ""),
        "url": url,
        "type": "html",
        "seed": CURRENT_SEED_URL if CURRENT_SEED_URL else "unknown",
        "content_folder": content_folder,
        "content": data.get("markdown", data.get("text", ""))[:10000],
        "source_url": data.get("metadata", {}).get("sourceURL", url),
        "status_code": data.get("metadata", {}).get("statusCode", 200),
        "size_bytes": total_size,
        "date": datetime.now().isoformat(),
    }
    append_jsonl(metadata)

def crawl_numbered_details(app: FirecrawlApp, detail_urls: List[str], cfg: Dict[str, Any], crawled_urls: set):
    """Crawl detail pages for numbered documents"""
    delay = int(os.environ.get("DELAY_BETWEEN_REQUESTS", "2"))
    
    for detail_url in detail_urls:
        try:
            logger.info(f"Crawling numbered detail: {detail_url}")
            
            # Use crawl_url with limit=1 and maxDepth=2 (some URLs have /thongbao/ in path)
            crawl_params = {
                "limit": 1,
                "maxDepth": 2,
                "scrapeOptions": {
                    "formats": ["markdown", "html"],
                    "waitFor": 1000,
                    "timeout": 30000,
                }
            }
            
            crawl_result = app.crawl_url(detail_url, params=crawl_params, poll_interval=2)
            
            if crawl_result.get("success"):
                data = crawl_result.get("data", [])
                if data and len(data) > 0:
                    page_data = data[0]  # Get first (and only) page
                    save_content(detail_url, page_data)
                    logger.info(f"✓ Saved numbered detail: {detail_url}")
            else:
                error_msg = crawl_result.get('error', 'Unknown error')
                logger.error(f"Failed to crawl detail {detail_url}: {error_msg}")
            
            time.sleep(delay)
            
        except Exception as e:
            logger.error(f"Error crawling detail {detail_url}: {e}")
            time.sleep(delay)

def crawl_single_seed(app: FirecrawlApp, seed_url: str, cfg: Dict[str, Any], crawled_urls: set) -> dict:
    """Crawl a single seed URL (for parallel execution)"""
    global CURRENT_SEED_URL
    CURRENT_SEED_URL = seed_url
    
    max_retries = 5  # Increased from 3 to handle rate limiting better
    retry_delay = 10  # Increased from 5 to give server more time
    result = {"seed_url": seed_url, "success": False, "pages": 0, "errors": 0}
    
    for attempt in range(max_retries):
        try:
            logger.info(f"Starting crawl for: {seed_url} (attempt {attempt + 1}/{max_retries})")
            
            crawl_params = {
                "limit": 500,
                "maxDepth": cfg.get("max_depth", 3),
                "scrapeOptions": {
                    "formats": ["markdown", "html"],
                    "waitFor": 1000,
                    "timeout": 30000,
                    "headers": {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    }
                }
            }
            
            if cfg.get("include_patterns"):
                crawl_params["includePaths"] = cfg["include_patterns"]
            if cfg.get("exclude_patterns"):
                crawl_params["excludePaths"] = cfg["exclude_patterns"]
            
            crawl_result = app.crawl_url(seed_url, params=crawl_params, poll_interval=5)
            
            if crawl_result.get("success"):
                data = crawl_result.get("data", [])
                logger.info(f"Crawled {len(data)} pages from {seed_url}")
                
                success_count = 0
                skipped_count = 0
                detail_urls_found = []  # Track new detail URLs from this seed
                
                for page in data:
                    try:
                        page_url = page.get("metadata", {}).get("sourceURL", seed_url)
                        # Check both the local set and the global in-memory set so
                        # URLs saved during this run are respected immediately.
                        if page_url in crawled_urls or page_url in CRAWLED_URLS_SET:
                            skipped_count += 1
                            crawl_stats.add_skipped()
                            logger.debug(f"Skipped (cached): {page_url}")
                            continue
                        
                        # Before saving, check if this is a listing page with numbered docs
                        html_content = page.get("html", "")
                        if "quydinh_huongdan" in get_content_folder(page_url, page.get("metadata", {}).get("title", "")):
                            new_detail_urls = parse_numbered_list_from_html(html_content, page_url)
                            detail_urls_found.extend(new_detail_urls)
                        elif "de-mo-nganh" in get_content_folder(page_url, page.get("metadata", {}).get("title", "")):
                            # For "đề án" pages, extract detail links (similar to numbered docs)
                            new_detail_urls = parse_de_mo_nganh_list_from_html(html_content, page_url)
                            detail_urls_found.extend(new_detail_urls)
                        
                        save_content(page_url, page)
                        success_count += 1
                    except Exception as e:
                        error_cat = categorize_error(e)
                        crawl_stats.add_error(error_cat)
                        logger.error(f"[{error_cat}] Failed to save page: {e}")
                        result["errors"] += 1
                
                result["success"] = True
                result["pages"] = success_count
                logger.info(f"Saved {success_count}/{len(data)} pages, skipped {skipped_count} (cached) from {seed_url}")
                
                # After processing listing page, crawl detail URLs found in this seed
                if detail_urls_found:
                    # Filter out already crawled URLs
                    detail_urls_to_crawl = [url for url in detail_urls_found if url not in crawled_urls and url not in CRAWLED_URLS_SET]
                    if detail_urls_to_crawl:
                        logger.info(f"Found {len(detail_urls_to_crawl)} new numbered detail pages to crawl from {seed_url}")
                        crawl_numbered_details(app, detail_urls_to_crawl, cfg, crawled_urls)
                
                break
            else:
                error_msg = crawl_result.get('error', 'Unknown error')
                error_cat = categorize_error(Exception(error_msg))
                crawl_stats.add_error(error_cat)
                logger.error(f"[{error_cat}] Crawl failed for {seed_url}: {error_msg}")
                
                if attempt < max_retries - 1:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    logger.error(f"Max retries reached for {seed_url}")
                    mark_failed_url(seed_url, error_msg, seed_url, max_retries)
        
        except Exception as e:
            error_cat = categorize_error(e)
            crawl_stats.add_error(error_cat)
            logger.error(f"[{error_cat}] Error crawling {seed_url}: {e}")
            
            if attempt < max_retries - 1:
                logger.info(f"Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
                retry_delay *= 2
            else:
                logger.error(f"Max retries reached for {seed_url}")
                mark_failed_url(seed_url, str(e), seed_url, max_retries)
                result["errors"] += 1
    
    return result

def crawl_with_firecrawl(app: FirecrawlApp, seed_urls: List[str], cfg: Dict[str, Any]):
    """Crawl multiple seeds with parallel execution and checkpoint support"""
    global CURRENT_SEED_URL
    
    crawled_urls = load_crawled_urls()
    # Initialize the global in-memory cache so mark_url_crawled() can keep it
    # up-to-date during the run. We still pass the local set to worker funcs
    # for compatibility.
    global CRAWLED_URLS_SET
    # Use the same set object for both the local variable and the global so
    # updates via mark_url_crawled() are immediately visible to worker code.
    CRAWLED_URLS_SET = crawled_urls
    logger.info(f"Loaded {len(crawled_urls)} URLs from cache")
    
    checkpoint = load_checkpoint()
    start_index = 0
    
    if checkpoint:
        try:
            checkpoint_url = checkpoint.get("seed_url")
            if checkpoint_url in seed_urls:
                start_index = seed_urls.index(checkpoint_url)
                logger.info(f"Resuming from checkpoint: {checkpoint_url} (index {start_index})")
        except (ValueError, KeyError) as e:
            logger.warning(f"Could not resume from checkpoint: {e}")
    
    seeds_to_crawl = seed_urls[start_index:]
    logger.info(f"Crawling {len(seeds_to_crawl)} seeds (starting from index {start_index})")
    
    max_workers = int(os.environ.get("MAX_WORKERS", "3"))
    logger.info(f"Using {max_workers} parallel workers")
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all tasks
        future_to_seed = {
            executor.submit(crawl_single_seed, app, seed_url, cfg, crawled_urls): (i + start_index, seed_url)
            for i, seed_url in enumerate(seeds_to_crawl)
        }
        
        # Process completed tasks
        for future in as_completed(future_to_seed):
            seed_index, seed_url = future_to_seed[future]
            
            try:
                result = future.result()
                save_checkpoint(seed_url, seed_index)
                logger.info(f"Progress: {seed_index + 1}/{len(seed_urls)} seeds completed")
                
                if (seed_index + 1) % 5 == 0:
                    crawl_stats.save_report()
                
            except Exception as e:
                error_cat = categorize_error(e)
                crawl_stats.add_error(error_cat)
                logger.error(f"[{error_cat}] Failed to process seed {seed_url}: {e}")
            
            time.sleep(1)
    
    clear_checkpoint()
    logger.info("All seeds crawled successfully")

def scrape_with_firecrawl(app: FirecrawlApp, urls: List[str]):
    for url in urls:
        try:
            logger.info(f"Scraping: {url}")
            
            scrape_result = app.scrape_url(url, params={
                "formats": ["markdown", "html"],
            })
            
            if scrape_result.get("success"):
                save_content(url, scrape_result)
            else:
                logger.error(f"Scrape failed for {url}")
        
        except Exception as e:
            logger.error(f"Error scraping {url}: {e}")
        
        time.sleep(1)

def crawl_once():
    """Execute one crawl cycle with improved error handling and stats"""
    cfg = load_config()
    ensure_dirs()
    
    if not wait_for_firecrawl():
        logger.error("Firecrawl services not available, aborting")
        return
    
    try:
        app = FirecrawlApp(api_url=FIRECRAWL_URL)
        
        seed_urls = cfg.get("seed_urls", [])
        if not seed_urls:
            logger.warning("No seed URLs configured")
            return
        
        logger.info(f"Starting crawl with {len(seed_urls)} seed URLs")
        
        global crawl_stats
        crawl_stats = CrawlStats()
        
        crawl_with_firecrawl(app, seed_urls, cfg)
        
        rebuild_metadata_json()
        logger.info(f"Rebuilt {META_JSON}")
        
        crawl_stats.save_report()
        report = crawl_stats.get_report()
        
        logger.info("=" * 80)
        logger.info("CRAWL SUMMARY")
        logger.info("=" * 80)
        logger.info(f"Total Pages: {report['summary']['total_pages']}")
        logger.info(f"Success: {report['summary']['success_count']} ({report['summary']['success_rate']}%)")
        logger.info(f"Errors: {report['summary']['error_count']}")
        logger.info(f"Skipped (cached): {report['summary']['skipped_count']}")
        logger.info(f"Total Size: {report['summary']['total_size_mb']} MB")
        logger.info(f"Duration: {report['performance']['duration_minutes']} minutes")
        logger.info(f"Speed: {report['performance']['pages_per_minute']} pages/min")
        if report['errors_by_category']:
            logger.info(f"Error Categories: {report['errors_by_category']}")
        logger.info("=" * 80)
    
    except Exception as e:
        error_cat = categorize_error(e)
        crawl_stats.add_error(error_cat)
        logger.error(f"[{error_cat}] Crawl failed: {e}")
        
        crawl_stats.save_report()
        mark_failed_url("CRAWL_PROCESS", str(e), "SYSTEM", 1)

if __name__ == "__main__":
    logger.info("=" * 80)
    logger.info("UIT CRAWLER - FIRECRAWL SELF-HOSTED")
    logger.info("=" * 80)
    logger.info(f"Firecrawl endpoint: {FIRECRAWL_URL}")
    logger.info(f"Output directory: {OUTPUT_DIR}")
    logger.info(f"Schedule: Every {SCHEDULE_HOURS} hours")
    logger.info(f"Run once mode: {RUN_ONCE}")
    logger.info("=" * 80)
    
    crawl_once()
    
    if RUN_ONCE:
        logger.info("Run-once complete. Exiting.")
    else:
        hours = max(SCHEDULE_HOURS, 1)
        while True:
            logger.info(f"Next crawl in {hours} hours")
            try:
                time.sleep(hours * 3600)
                logger.info("Starting scheduled crawl...")
                crawl_once()
            except KeyboardInterrupt:
                logger.info("Interrupted by user")
                break
            except Exception as e:
                logger.error(f"Scheduled crawl failed: {e}")
                time.sleep(300)
    
    logger.info("=" * 80)
    logger.info("UIT crawler stopped")
    logger.info("=" * 80)