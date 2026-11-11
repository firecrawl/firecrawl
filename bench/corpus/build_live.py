#!/usr/bin/env python3
"""Build bench/corpus/live.json: ~120 public URLs for the live run.

  python3 bench/corpus/build_live.py

Three groups:
  * static HTML pages: a stratified sample of the static corpus's source URLs; snippets come from
    today's snapshot of the page (same generator as the static truth).
  * js: candidates from live-candidates.json that are loaded twice, once with a plain GET and once
    in the locally installed Chrome (headless, --dump-dom). A candidate is kept as js:true only if
    the rendered DOM yields >= 2 snippets and NONE of them is in the plain-GET text.
  * hard: candidates that commonly block bots. Kept only if Chrome rendered real content (so the
    snippets are verified); the plain-GET status is recorded as evidence of blocking.
Chrome is used as a browser to look at the page, not as an engine under test; no scraper output is read.
"""
import datetime
import json
import os
import re
import hashlib
import shutil
import signal
import subprocess
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_truth as g  # noqa: E402

WORK = os.path.join(HERE, '..', '.work', 'live')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
BENCH_UA = 'firecrawl-bench/0.1 (+https://github.com/firecrawl/firecrawl)'
CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
CHALLENGE = re.compile(r'just a moment|verify you are (a )?human|are you a robot|access denied|unusual traffic|captcha|enable javascript and cookies|'
                       r'press (and|&) hold|request blocked|pardon our interruption|security check|not a robot|robot or human|could not be processed|blocked', re.I)
PER_CATEGORY = {'docs': 12, 'blog': 8, 'article': 7, 'wikipedia': 9, 'github': 6, 'forum': 5, 'product': 8, 'tables': 6,
                'code': 6, 'long': 4, 'tiny': 4}
SKIP_LIVE = {'https://news.ycombinator.com/', 'https://danluu.com/', 'https://quotes.toscrape.com/'}  # change too often
NOW = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def snippets_from(truth, want=3):
    order = ['heading', 'early', 'mid', 'late', 'extra', 'table_row', 'code_line', 'pre_line']
    items = sorted(truth['must_contain'], key=lambda m: order.index(m['kind']))
    out = []
    for m in items:
        if len(g.norm(m['text'])) >= 12 and m['text'] not in out:
            out.append(m['text'])
        if len(out) >= want:
            break
    return out


def plain_get(url):
    req = urllib.request.Request(url.split('#')[0], headers={'User-Agent': BENCH_UA, 'Accept': 'text/html,*/*;q=0.5'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read(6_000_000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, ''
    except Exception as e:  # noqa: BLE001
        return 0, ''


def chrome_dom(url, slot):
    # one throwaway profile per page load: two Chromes sharing a profile hand off to each other and print nothing
    prof = os.path.join(WORK, 'chrome-profile-%d' % slot)
    shutil.rmtree(prof, ignore_errors=True)
    cmd = [CHROME, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
           '--user-data-dir=' + prof, '--window-size=1366,2400', '--user-agent=' + CHROME_UA,
           '--virtual-time-budget=10000', '--dump-dom', url]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        out, _ = p.communicate(timeout=60)
        dom = out.decode('utf-8', 'replace')
    except subprocess.TimeoutExpired:
        dom = ''
    try:
        os.killpg(p.pid, signal.SIGKILL)  # no stray helpers
    except OSError:
        pass
    p.wait()
    shutil.rmtree(prof, ignore_errors=True)
    return dom


def check(args):
    i, url, category, group = args
    cache = os.path.join(WORK, 'checks', hashlib.sha1((group + ' ' + url).encode()).hexdigest() + '.json')
    if os.path.exists(cache) and '--refresh' not in sys.argv:
        return json.load(open(cache))
    rec = check_uncached(i, url, category, group)
    if rec.get('why') != 'chrome-empty':
        json.dump(rec, open(cache, 'w'), ensure_ascii=False, indent=1)
    return rec


def check_uncached(i, url, category, group):
    status, plain = plain_get(url)
    dom = chrome_dom(url, i)
    rec = {'url': url, 'category': category, 'group': group, 'plain_status': status, 'dom_bytes': len(dom), 'keep': False}
    if len(dom) < 500:
        rec['why'] = 'chrome-empty'
        return rec
    truth, main_raw, rest_raw = g.gen('live', url, category, dom)
    text_len = len(g.collapse(main_raw)) + len(g.collapse(rest_raw))
    snips = snippets_from(truth, want=6)
    rec['snippets'] = snips
    rec['rendered_text_chars'] = text_len
    title = (re.search(r'<title[^>]*>([^<]*)', dom) or [None, ''])[1]
    if text_len < 6000 and CHALLENGE.search(title + ' ' + main_raw[:1500] + rest_raw[:1500]):
        rec['why'] = 'chrome-blocked'
        return rec
    plain_text = ''
    if plain:
        _, pm, pr = g.gen('live', url, category, plain)
        plain_text = g.norm(pm + ' ' + pr)
    in_plain = [s for s in snips if g.norm(s) in plain_text]
    rec['in_plain_get'] = len(in_plain)
    rec['plain_text_chars'] = len(plain_text)
    if group == 'js':
        # keep only snippets a plain GET does not show, so success on this page really needs JavaScript
        only_js = [s for s in snips if s not in in_plain][:3]
        rec['snippets'] = only_js
        if len(only_js) < 2:
            rec['why'] = 'content-already-in-plain-get' if in_plain else 'too-few-snippets'
            return rec
        rec['keep'] = True
    else:
        rec['snippets'] = snips[:3]
        rec['blocked_plain_get'] = status in (0, 401, 403, 406, 429, 503) or len(in_plain) == 0
        if len(snips) < 2:
            rec['why'] = 'too-few-snippets'
        elif not rec['blocked_plain_get']:
            rec['why'] = 'plain-get-not-blocked'
        else:
            rec['keep'] = True
    return rec


def main():
    os.makedirs(os.path.join(WORK, 'checks'), exist_ok=True)
    manifest = json.load(open(os.path.join(HERE, 'manifest.json')))
    urls = []
    by_cat = {}
    for m in manifest:
        if m['category'] in PER_CATEGORY and m['url'] not in SKIP_LIVE:
            by_cat.setdefault(m['category'], []).append(m)
    for cat, want in PER_CATEGORY.items():
        pages = by_cat.get(cat, [])
        step = max(1.0, len(pages) / float(want))
        picked = []
        k = 0.0
        while len(picked) < want and int(k) < len(pages):
            m = pages[int(k)]
            truth = json.load(open(os.path.join(HERE, 'truth', m['id'] + '.json')))
            snips = snippets_from(truth)
            if len(snips) >= 2:
                picked.append({'url': m['url'], 'category': cat, 'must_contain': snips,
                               'verified': {'method': 'plain-get-snapshot', 'at': m['fetched_at'], 'static_id': m['id']}})
            k += step
        urls.extend(picked)

    cands = json.load(open(os.path.join(HERE, 'live-candidates.json')))
    jobs = []
    for group in ('js', 'hard'):
        for url, cat in cands[group]:
            jobs.append((len(jobs), url, cat, group))
    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(check, jobs))
    json.dump(results, open(os.path.join(WORK, 'candidate-checks.json'), 'w'), indent=1, ensure_ascii=False)
    for r in results:
        print('%-4s %-5s plain=%s dom=%7d in_plain=%s %-28s %s' % ('KEEP' if r['keep'] else 'drop', r['group'], r['plain_status'], r['dom_bytes'],
                                                                 r.get('in_plain_get', '-'), r.get('why', ''), r['url'][:80]))
        if not r['keep']:
            continue
        entry = {'url': r['url'], 'category': r['category'], 'must_contain': r['snippets'],
                 'verified': {'method': 'chrome-headless-dom', 'at': NOW, 'plain_get_status': r['plain_status']}}
        if r['group'] == 'js':
            entry['js'] = True
        else:
            entry['hard'] = True
            entry['verified']['plain_get_blocked'] = r.get('blocked_plain_get', False)
        urls.append(entry)
    for i, u in enumerate(urls):
        u['id'] = 'L%03d' % (i + 1)
    out = {
        'generated_at': NOW,
        'note': 'Live corpus. must_contain snippets were on the page when generated; live pages drift, so the scorer accepts 2 of 3.',
        'counts': {'total': len(urls), 'js': sum(1 for u in urls if u.get('js')), 'hard': sum(1 for u in urls if u.get('hard'))},
        'urls': [dict([('id', u['id'])] + [(k, v) for k, v in u.items() if k != 'id']) for u in urls],
    }
    json.dump(out, open(os.path.join(HERE, 'live.json'), 'w'), indent=1, ensure_ascii=False)
    print(out['counts'])


if __name__ == '__main__':
    main()
