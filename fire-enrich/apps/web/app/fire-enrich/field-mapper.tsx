"use client";

import { useState } from "react";
import { EnrichmentField } from "@/lib/types";
import { generateVariableName } from "@/lib/utils/field-utils";
import { FieldDefinitionType } from "@/lib/types/field-generation";
import { Button } from "@/components/ui/button";
import Input from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

interface FieldMapperProps {
  columns: string[];
  onFieldsSelected: (fields: EnrichmentField[]) => void;
}

const PRESET_FIELDS: Omit<EnrichmentField, "name">[] = [
  {
    displayName: "Company Name",
    description: "The name of the company",
    type: "string",
    required: false,
  },
  {
    displayName: "Company Description",
    description: "A brief description of what the company does",
    type: "string",
    required: false,
  },
  {
    displayName: "Industry",
    description: "The industry or sector the company operates in",
    type: "string",
    required: false,
  },
  {
    displayName: "Employee Count",
    description: "Approximate number of employees",
    type: "number",
    required: false,
  },
  {
    displayName: "Location",
    description: "Company headquarters location",
    type: "string",
    required: false,
  },
  {
    displayName: "YC Company",
    description: "Is this a Y Combinator company?",
    type: "boolean",
    required: false,
  },
  {
    displayName: "Website",
    description: "Company website URL",
    type: "string",
    required: false,
  },
];

export function FieldMapper({ onFieldsSelected }: FieldMapperProps) {
  const getInitialFields = () => {
    const existingNames: string[] = [];
    // Start with company description and website
    const initialPresets = [
      PRESET_FIELDS[1], // Company Description
      PRESET_FIELDS[6], // Website
    ];
    return initialPresets.map((preset) => {
      const name = generateVariableName(preset.displayName, existingNames);
      existingNames.push(name);
      return { ...preset, name };
    });
  };

  const [selectedFields, setSelectedFields] =
    useState<EnrichmentField[]>(getInitialFields());
  const [customField, setCustomField] = useState<{
    displayName: string;
    description: string;
    type: "string" | "number" | "boolean" | "array";
  }>({
    displayName: "",
    description: "",
    type: "string",
  });
  const [nlPrompt, setNlPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [suggestedFields, setSuggestedFields] = useState<FieldDefinitionType[]>(
    [],
  );
  const [showSuggestions, setShowSuggestions] = useState(false);

  const addField = (preset: Omit<EnrichmentField, "name">) => {
    const existingNames = selectedFields.map((f) => f.name);
    const name = generateVariableName(preset.displayName, existingNames);
    const field: EnrichmentField = { ...preset, name };

    if (
      selectedFields.length < 10 &&
      !selectedFields.find((f) => f.displayName === preset.displayName)
    ) {
      setSelectedFields([...selectedFields, field]);
    }
  };

  const removeField = (fieldName: string) => {
    setSelectedFields(selectedFields.filter((f) => f.name !== fieldName));
  };

  const addCustomField = () => {
    if (
      customField.displayName &&
      customField.description &&
      selectedFields.length < 10
    ) {
      const existingNames = selectedFields.map((f) => f.name);
      const name = generateVariableName(customField.displayName, existingNames);
      setSelectedFields([
        ...selectedFields,
        {
          name,
          displayName: customField.displayName,
          description: customField.description,
          type: customField.type,
          required: false,
        },
      ]);
      setCustomField({ displayName: "", description: "", type: "string" });
    }
  };

  const handleProceed = () => {
    if (selectedFields.length > 0) {
      onFieldsSelected(selectedFields);
    }
  };

  const generateFieldsFromNL = async () => {
    if (!nlPrompt.trim()) return;

    setIsGenerating(true);
    try {
      const response = await fetch("/api/generate-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: nlPrompt }),
      });

      const result = await response.json();
      if (result.success && result.data.fields) {
        setSuggestedFields(result.data.fields);
        setShowSuggestions(true);
      }
    } catch (error) {
      console.error("Failed to generate fields:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  const acceptSuggestedFields = () => {
    const existingNames = selectedFields.map((f) => f.name);
    const newFields = suggestedFields.map((suggestion) => {
      const name = generateVariableName(suggestion.displayName, existingNames);
      existingNames.push(name);
      return {
        name,
        displayName: suggestion.displayName,
        description: suggestion.description,
        type: suggestion.type,
        required: false,
      };
    });

    setSelectedFields([...selectedFields, ...newFields]);
    setSuggestedFields([]);
    setShowSuggestions(false);
    setNlPrompt("");
  };

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-body-small font-semibold mb-2">
          Select fields to enrich (max 10)
        </h3>

        {/* Preset fields */}
        <div className="mb-2">
          <p className="text-body-x-small text-gray-600 mb-1">Quick add fields:</p>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_FIELDS.map((preset) => {
              const isSelected =
                selectedFields.find(
                  (f) => f.displayName === preset.displayName,
                ) !== undefined;
              return (
                <button
                  key={preset.displayName}
                  onClick={() => addField(preset)}
                  disabled={isSelected}
                  className={`inline-flex items-center px-2.5 py-1 rounded-full text-body-x-small font-medium transition-all ${
                    isSelected
                      ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                      : "bg-orange-100 text-orange-900 hover:bg-orange-200"
                  }`}
                >
                  {preset.displayName}
                  {!isSelected && (
                    <svg
                      className="ml-1 -mr-0.5 h-3 w-3"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Suggested Fields Preview */}
        {showSuggestions && suggestedFields.length > 0 && (
          <div className="mb-2 p-3 bg-orange-50 rounded-lg border border-orange-200">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-body-small font-semibold text-gray-900">
                Suggested Fields
              </h4>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setSuggestedFields([]);
                    setShowSuggestions(false);
                  }}
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-body-x-small border-gray-300 hover:bg-gray-100"
                >
                  Cancel All
                </Button>
                <Button
                  onClick={acceptSuggestedFields}
                  variant="orange"
                  size="sm"
                  className="h-7 px-3 text-body-x-small"
                >
                  Accept All
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              {suggestedFields.map((field, index) => (
                <div
                  key={index}
                  className="p-2.5 bg-white rounded-md border border-gray-200"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="font-medium text-body-small text-gray-900">
                        {field.displayName}
                      </div>
                      <div className="text-body-x-small text-gray-600 mt-0.5">
                        {field.description}
                      </div>
                    </div>
                    <div className="flex gap-0.5">
                      <button
                        onClick={() => {
                          const fieldToAdd = suggestedFields[index];
                          if (
                            selectedFields.length < 10 &&
                            fieldToAdd.displayName &&
                            fieldToAdd.description
                          ) {
                            addField({
                              displayName: fieldToAdd.displayName,
                              description: fieldToAdd.description,
                              type: fieldToAdd.type,
                              required: false,
                            });
                            const newSuggestions = suggestedFields.filter(
                              (_, i) => i !== index,
                            );
                            setSuggestedFields(newSuggestions);
                            if (newSuggestions.length === 0) {
                              setShowSuggestions(false);
                            }
                          }
                        }}
                        className="p-1 text-green-600 hover:text-green-700 hover:bg-green-50 rounded"
                        title="Accept this field"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          const newSuggestions = suggestedFields.filter(
                            (_, i) => i !== index,
                          );
                          setSuggestedFields(newSuggestions);
                          if (newSuggestions.length === 0) {
                            setShowSuggestions(false);
                          }
                        }}
                        className="p-1 text-red-600 hover:text-red-700 hover:bg-red-50 rounded"
                        title="Remove this field"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Selected fields */}
      <div className="mt-2">
        <h4 className="text-body-x-small font-medium mb-1">
          Selected fields ({selectedFields.length}/10):
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {selectedFields.map((field) => (
            <div
              key={field.name}
              className="inline-flex items-center px-2.5 py-1 rounded-full text-body-x-small font-medium bg-black text-white group"
            >
              <span title={field.description}>{field.displayName}</span>
              <button
                onClick={() => removeField(field.name)}
                className="ml-1 -mr-0.5 inline-flex items-center justify-center w-4 h-4 text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
              >
                <svg
                  className="w-3 h-3"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Add more fields section */}
      {selectedFields.length < 10 && (
        <div className="border-t pt-2">
          {/* Natural Language Input */}
          <div className="mb-2">
            <p className="text-body-x-small text-gray-600 mb-1">
              Describe fields you want to collect:
            </p>
            <div className="flex gap-1">
              <Input
                type="text"
                value={nlPrompt}
                onChange={(e) => setNlPrompt(e.target.value)}
                onClick={() => setNlPrompt("")}
                onKeyDown={(e) => e.key === "Enter" && generateFieldsFromNL()}
                placeholder="e.g., I want company bio, size, recent fundraising"
                className="flex-1 h-8 text-body-x-small"
                disabled={isGenerating}
              />
              <Button
                onClick={generateFieldsFromNL}
                disabled={isGenerating || !nlPrompt.trim()}
                variant={
                  isGenerating || !nlPrompt.trim() ? "secondary" : "default"
                }
                size="sm"
                className={
                  isGenerating || !nlPrompt.trim()
                    ? ""
                    : "bg-black hover:bg-gray-800 text-white"
                }
              >
                {isGenerating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Generate"
                )}
              </Button>
            </div>
          </div>

          {/* Custom field */}
          <p className="text-body-x-small text-gray-600 mb-1">Or add custom field:</p>
          <div className="grid grid-cols-3 gap-1">
            <Input
              type="text"
              placeholder="Field name"
              value={customField.displayName}
              onChange={(e) =>
                setCustomField({ ...customField, displayName: e.target.value })
              }
              onClick={() =>
                setCustomField({ ...customField, displayName: "" })
              }
              className="h-8 text-body-x-small"
            />
            <Input
              type="text"
              placeholder="Description"
              value={customField.description}
              onChange={(e) =>
                setCustomField({ ...customField, description: e.target.value })
              }
              onClick={() =>
                setCustomField({ ...customField, description: "" })
              }
              className="h-8 text-body-x-small"
            />
            <div className="flex gap-1">
              <Select
                value={customField.type}
                onValueChange={(value) =>
                  setCustomField({
                    ...customField,
                    type: value as "string" | "number" | "boolean" | "array",
                  })
                }
              >
                <SelectTrigger className="h-8 text-body-x-small flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">Text</SelectItem>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="boolean">Yes/No</SelectItem>
                  <SelectItem value="array">List</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={addCustomField}
                disabled={!customField.displayName || !customField.description}
                variant="orange"
                size="sm"
              >
                Add
              </Button>
            </div>
          </div>
        </div>
      )}

      <Button
        onClick={handleProceed}
        disabled={selectedFields.length === 0}
        variant="orange"
        className="w-full mt-2"
      >
        Start Enrichment
      </Button>
    </div>
  );
}
