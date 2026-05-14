import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { FieldGenerationResponse } from '@/lib/types/field-generation';
import {
  NoKeyAvailableError,
  QuotaExceededError,
  withBearer,
  withOpenAI,
} from '@fire-enrich/core/server';
import { getDb } from '@fire-enrich/db';

export const POST = async (req: Request) => {
  const handler = withBearer(async (r, { principal }) => {
    let prompt: unknown;
    try {
      const body = await r.json();
      prompt = body?.prompt;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Prompt is required' },
        { status: 400 }
      );
    }

    const db = getDb();
    try {
      const parsed = await withOpenAI(
        principal,
        'generate_fields',
        db,
        async (key) => {
          const openai = new OpenAI({ apiKey: key.key });
          const completion = await openai.chat.completions.create({
            model: 'gpt-5',
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
              {
                role: 'user',
                content: prompt as string,
              },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'field_generation',
                strict: true,
                schema: zodResponseFormat(
                  FieldGenerationResponse,
                  'field_generation'
                ).json_schema.schema,
              },
            },
          });

          const message = completion.choices[0].message;

          if (!message.content) {
            throw new Error('No response content');
          }

          return JSON.parse(message.content) as z.infer<
            typeof FieldGenerationResponse
          >;
        }
      );

      return NextResponse.json({
        success: true,
        data: parsed,
      });
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        return NextResponse.json(
          { code: error.code, error: error.message, scope: error.scope },
          { status: 429 }
        );
      }
      if (error instanceof NoKeyAvailableError) {
        return NextResponse.json(
          { code: error.code, error: error.message, scope: error.scope },
          { status: 503 }
        );
      }
      console.error('Field generation error:', error);
      return NextResponse.json(
        { error: 'Failed to generate fields' },
        { status: 500 }
      );
    }
  });

  return handler(req, { db: getDb() });
};
