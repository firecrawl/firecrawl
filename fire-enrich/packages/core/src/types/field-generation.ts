import { z } from 'zod';

// Zod schema for field generation - all fields must be required for Structured Outputs
export const FieldDefinition = z.object({
  displayName: z.string().describe('Human-readable name for the field'),
  description: z.string().describe('Description of what data this field should contain'),
  type: z.enum(['string', 'number', 'boolean', 'array']).describe('The data type of the field'),
  examples: z.array(z.string()).describe('Example values for this field, empty array if none'),
});

export const FieldGenerationResponse = z.object({
  fields: z.array(FieldDefinition).describe('Array of field definitions based on user input'),
  interpretation: z.string().describe('Brief explanation of what fields were created'),
});

export type FieldDefinitionType = z.infer<typeof FieldDefinition>;
export type FieldGenerationResponseType = z.infer<typeof FieldGenerationResponse>;