export interface ParsedEmail {
  localPart: string;
  domain: string;
  companyName?: string;
  firstName?: string;
  lastName?: string;
}

export function parseEmail(email: string): ParsedEmail | null {
  const emailRegex = /^([^@]+)@([^@]+)$/;
  const match = email.match(emailRegex);
  
  if (!match) {
    return null;
  }

  const [, localPart, domain] = match;
  const result: ParsedEmail = {
    localPart,
    domain,
  };

  // Extract company name from domain and capitalize properly
  const domainParts = domain.split('.');
  if (domainParts.length >= 2) {
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
      'firecrawl': 'Firecrawl',
    };
    
    // Get the main domain part
    const rawName = domainParts[0].toLowerCase();
    
    // Check if it's a known company
    if (knownCompanies[rawName]) {
      result.companyName = knownCompanies[rawName];
    } else {
      // Handle hyphenated names: my-company -> My Company
      const words = domainParts[0].split('-').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      );
      result.companyName = words.join(' ');
    }
  }

  // Try to extract name from local part
  const nameParts = localPart.split(/[._-]/);
  if (nameParts.length >= 2) {
    result.firstName = nameParts[0];
    result.lastName = nameParts[nameParts.length - 1];
  } else if (nameParts.length === 1) {
    // Check if it's a combined name like "johnsmith"
    const combinedMatch = localPart.match(/^([a-z]+)([A-Z][a-z]+)$/);
    if (combinedMatch) {
      result.firstName = combinedMatch[1];
      result.lastName = combinedMatch[2].toLowerCase();
    }
  }

  return result;
}

export function generateSearchQueriesFromEmail(parsedEmail: ParsedEmail): string[] {
  const queries: string[] = [];

  // Prioritize site-specific search first
  queries.push(`site:${parsedEmail.domain}`);
  
  // Company website search
  if (parsedEmail.companyName) {
    queries.push(`site:${parsedEmail.domain} about team company`);
    queries.push(`${parsedEmail.companyName} company`);
  } else {
    // If no company name parsed, use domain for searches
    queries.push(`"${parsedEmail.domain}" company information`);
  }

  // Person search
  if (parsedEmail.firstName && parsedEmail.lastName) {
    const fullName = `${parsedEmail.firstName} ${parsedEmail.lastName}`;
    queries.push(`"${fullName}" ${parsedEmail.companyName || parsedEmail.domain}`);
  }

  return queries;
}