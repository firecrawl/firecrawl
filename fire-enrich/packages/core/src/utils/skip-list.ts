import fs from 'fs/promises';
import path from 'path';

let skipListCache: Set<string> | null = null;

export async function loadSkipList(): Promise<Set<string>> {
  if (skipListCache) {
    return skipListCache;
  }

  try {
    const skipListPath = path.join(process.cwd(), 'app', 'fire-enrich', 'skip-list.txt');
    const content = await fs.readFile(skipListPath, 'utf-8');
    
    const skipDomains = new Set<string>();
    
    content.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      // Skip empty lines and comments
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        skipDomains.add(trimmedLine.toLowerCase());
      }
    });
    
    skipListCache = skipDomains;
    return skipDomains;
  } catch (error) {
    console.error('Failed to load skip list:', error);
    // Return default set if file doesn't exist
    return new Set([
      'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 
      'aol.com', 'icloud.com', 'protonmail.com'
    ]);
  }
}

export function shouldSkipEmail(email: string, skipList: Set<string>): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  
  // Check exact domain match
  if (skipList.has(domain)) return true;
  
  // Check for educational domains
  if (domain.endsWith('.edu') || domain.endsWith('.ac.uk')) return true;
  
  return false;
}

export function getSkipReason(email: string, skipList: Set<string>): string {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return 'Invalid email';
  
  if (skipList.has(domain)) {
    if (['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com'].includes(domain)) {
      return 'Common email provider';
    }
    if (domain.includes('mail')) {
      return 'Temporary/free email service';
    }
    return 'Domain in skip list';
  }
  
  if (domain.endsWith('.edu') || domain.endsWith('.ac.uk')) {
    return 'Educational domain';
  }
  
  return 'Unknown';
}