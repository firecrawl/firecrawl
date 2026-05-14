import { z } from 'zod';
import { FieldGenerationResponse } from '../types/field-generation.js';
import type { LLMProvider } from '../llm/provider.js';

export async function generateFields({ prompt, llmProvider }: {
  prompt: string;
  llmProvider: LLMProvider;
}): Promise<z.infer<typeof FieldGenerationResponse>> {
  const result = await llmProvider.complete({
    tier: 'smart',
    messages: [
      {
        role: 'system',
        content: `You are an expert at understanding data enrichment needs and converting natural language requests into structured field definitions.

When the user describes what data they want to collect about companies, extract each distinct piece of information as a separate field.

Guidelines:
- Use clear, professional field names (e.g., "Company Size" not "size")
- Provide helpful descriptions that explain what data should be found
- Choose appropriate data types:
  - string: for text, URLs, descriptions
  - number: for counts, amounts, years
  - boolean: for yes/no questions
  - array: for lists of items
- Include example values when helpful
- Common fields include: Company Name, Description, Industry, Employee Count, Founded Year, Headquarters Location, Website, Funding Amount, etc.`,
      },
      { role: 'user', content: prompt },
    ],
    schema: FieldGenerationResponse,
    schemaName: 'field_generation',
  });

  if (result.parsed) {
    return result.parsed as z.infer<typeof FieldGenerationResponse>;
  }
  throw new Error('Field generation returned no parsed result');
}
