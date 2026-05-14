import { tool } from '@openai/agents';
import { z } from 'zod';
import { EmailContext } from '../core/types';

export function createEmailParserTool() {
  return tool({
    name: 'parse_email',
    description: 'Extract context from an email address',
    parameters: z.object({
      email: z.string().email().describe('Email address to parse'),
    }),
    async execute({ email }) {
      const [localPart, domain] = email.split('@');
      
      // Extract personal name from email
      const personalName = extractPersonalName(localPart);
      
      // Determine if it's a personal email
      const personalDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com'];
      const isPersonalEmail = personalDomains.includes(domain.toLowerCase());
      
      // Extract company domain and guess company name
      const companyDomain = isPersonalEmail ? undefined : domain;
      const companyNameGuess = companyDomain ? guessCompanyName(companyDomain) : undefined;
      
      const context: EmailContext = {
        email,
        domain,
        companyDomain,
        personalName,
        companyNameGuess,
        isPersonalEmail,
      };
      
      return context;
    },
  });
}

function extractPersonalName(localPart: string): string {
  // john.doe -> John Doe
  // jdoe -> J Doe
  // john_smith -> John Smith
  // john-smith -> John Smith
  const cleaned = localPart
    .replace(/[._-]/g, ' ')
    .replace(/[0-9]+/g, '')
    .trim();
    
  const parts = cleaned.split(' ').filter(Boolean);
  
  return parts
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function guessCompanyName(domain: string): string {
  // Known company mappings for proper capitalization
  const knownCompanies: Record<string, string> = {
    'onetrust': 'OneTrust',
    'sideguide': 'Sideguide',
    'frontapp': 'Front',
    'shippo': 'Shippo',
    'lattice': 'Lattice',
    'pilot': 'Pilot',
    'fundera': 'Fundera',
    'flexport': 'Flexport',
    'triplebyte': 'Triplebyte',
    'zola': 'Zola',
    'pinterest': 'Pinterest',
    'brex': 'Brex',
    'deel': 'Deel',
    'scale': 'Scale AI',
    'wiz': 'Wiz',
  };
  
  // Remove common TLDs and subdomains
  const cleaned = domain
    .replace(/^(www|app|api|mail|email)\./i, '')
    .replace(/\.(com|io|co|net|org|ai|app|dev|tech|xyz|me|us|uk|ca|au|de|fr|jp|cn|in|br)$/i, '');
  
  // Check if it's a known company
  const lowerCleaned = cleaned.toLowerCase();
  if (knownCompanies[lowerCleaned]) {
    return knownCompanies[lowerCleaned];
  }
  
  // Handle special cases
  // acme-corp.com -> Acme Corp
  // my-company -> My Company
  const words = cleaned
    .split(/[-.]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  
  return words.join(' ');
}