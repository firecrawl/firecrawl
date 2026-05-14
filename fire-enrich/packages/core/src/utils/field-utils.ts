export function generateVariableName(displayName: string, existingNames: string[]): string {
  // Convert display name to variable name format
  let varName = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .replace(/_+/g, '_'); // Replace multiple underscores with single
  
  // Ensure it starts with a letter
  if (varName && /^[0-9]/.test(varName)) {
    varName = 'field_' + varName;
  }
  
  // Handle empty result
  if (!varName) {
    varName = 'field';
  }
  
  // Check for conflicts and increment if needed
  let finalName = varName;
  let counter = 1;
  
  while (existingNames.includes(finalName)) {
    counter++;
    finalName = `${varName}_${counter}`;
  }
  
  return finalName;
}

export function formatDisplayName(name: string): string {
  // Convert variable_name to Display Name
  return name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}