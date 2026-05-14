"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Button from "@/components/shared/button/button";
import Input from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { CSVRow, EnrichmentField } from "@/lib/types";
import { detectEmailColumn, EMAIL_REGEX } from "@/lib/utils/email-detection";
import { generateVariableName } from "@/lib/utils/field-utils";
import { X, Plus, Sparkles, ChevronDown, ChevronUp, ArrowLeft, Copy } from "lucide-react";
import { toast } from "sonner";
import { AlertCircle } from "lucide-react";

interface UnifiedEnrichmentViewProps {
  rows: CSVRow[];
  columns: string[];
  onStartEnrichment: (emailColumn: string, fields: EnrichmentField[]) => void;
}

const PRESET_FIELDS: EnrichmentField[] = [
  {
    name: "companyName",
    displayName: "Company Name",
    description: "The name of the company",
    type: "string",
    required: false,
  },
  {
    name: "companyDescription",
    displayName: "Company Description",
    description: "A brief description of what the company does",
    type: "string",
    required: false,
  },
  {
    name: "industry",
    displayName: "Industry",
    description: "The primary industry the company operates in",
    type: "string",
    required: false,
  },
  {
    name: "employeeCount",
    displayName: "Employee Count",
    description: "The number of employees at the company",
    type: "number",
    required: false,
  },
  {
    name: "yearFounded",
    displayName: "Year Founded",
    description: "The year the company was founded",
    type: "number",
    required: false,
  },
  {
    name: "headquarters",
    displayName: "Headquarters",
    description: "The location of the company headquarters",
    type: "string",
    required: false,
  },
  {
    name: "fundingRaised",
    displayName: "Funding Raised",
    description: "Total funding raised by the company",
    type: "string",
    required: false,
  },
  {
    name: "fundingStage",
    displayName: "Funding Stage",
    description:
      "The current funding stage (e.g., Pre-seed, Seed, Series A, Series B, Series C, Series D+, IPO)",
    type: "string",
    required: false,
  },
];

export function UnifiedEnrichmentView({
  rows,
  columns,
  onStartEnrichment,
}: UnifiedEnrichmentViewProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [emailColumn, setEmailColumn] = useState<string>("");
  const [selectedFields, setSelectedFields] = useState<EnrichmentField[]>([
    // Default selected fields (3 fields)
    PRESET_FIELDS.find((f) => f.name === "companyName")!,
    PRESET_FIELDS.find((f) => f.name === "companyDescription")!,
    PRESET_FIELDS.find((f) => f.name === "industry")!,
  ]);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [showNaturalLanguage, setShowNaturalLanguage] = useState(false);
  const [naturalLanguageInput, setNaturalLanguageInput] = useState("");
  const [suggestedFields, setSuggestedFields] = useState<EnrichmentField[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);
  const [showEmailDropdown, setShowEmailDropdown] = useState(false);
  const [showEmailDropdownStep1, setShowEmailDropdownStep1] = useState(false);
  const [customField, setCustomField] = useState<{
    name: string;
    description: string;
    type: "string" | "number" | "boolean" | "array";
  }>({
    name: "",
    description: "",
    type: "string",
  });

  // Auto-detect email column but stay on step 1 for confirmation
  useEffect(() => {
    if (rows && columns && Array.isArray(rows) && Array.isArray(columns)) {
      const detection = detectEmailColumn(rows, columns);
      if (detection.columnName && detection.confidence > 50) {
        setEmailColumn(detection.columnName);
        // Stay on step 1 to let user confirm or change
      }
    }
  }, [rows, columns]);

  // Safety check for undefined props
  if (!rows || !columns || !Array.isArray(rows) || !Array.isArray(columns)) {
    return (
      <div className="center text-body-medium text-black-alpha-64">
        <p>No data available. Please upload a CSV file.</p>
      </div>
    );
  }

  const handleAddField = (field: EnrichmentField) => {
    if (selectedFields.length >= 10) {
      toast.error("Maximum 10 fields allowed");
      return;
    }
    if (!selectedFields.find((f) => f.name === field.name)) {
      setSelectedFields([...selectedFields, field]);
    }
  };

  const handleRemoveField = (fieldName: string) => {
    setSelectedFields(selectedFields.filter((f) => f.name !== fieldName));
  };

  const handleGenerateFields = async () => {
    if (!naturalLanguageInput.trim()) return;

    setIsGenerating(true);
    try {
      const response = await fetch("/api/generate-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: naturalLanguageInput }),
      });

      if (!response.ok) throw new Error("Failed to generate fields");

      const result = await response.json();

      // Convert API response format to frontend format
      if (result.success && result.data && result.data.fields) {
        const convertedFields = result.data.fields.map(
          (field: {
            displayName: string;
            description: string;
            type: string;
          }) => ({
            name: generateVariableName(
              field.displayName,
              selectedFields.map((f) => f.name),
            ),
            displayName: field.displayName,
            description: field.description,
            type:
              field.type === "text"
                ? "string"
                : field.type === "array"
                  ? "string"
                  : (field.type as "string" | "number" | "boolean" | "array"),
            required: false,
          }),
        );
        setSuggestedFields(convertedFields);
      } else {
        throw new Error("Invalid response format");
      }

      setShowNaturalLanguage(false);
      setNaturalLanguageInput("");
    } catch (error) {
      console.error("Error generating fields:", error);
      toast.error("Failed to generate fields. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddCustomField = () => {
    if (!customField.name || !customField.description) {
      toast.error("Please fill in all fields");
      return;
    }

    const fieldName = generateVariableName(
      customField.name,
      selectedFields.map((f) => f.name),
    );
    const newField: EnrichmentField = {
      name: fieldName,
      displayName: customField.name,
      description: customField.description,
      type: customField.type,
      required: false,
    };

    handleAddField(newField);
    setCustomField({ name: "", description: "", type: "string" });
    setShowManualAdd(false);
  };

  const displayRows = showAllRows ? rows : rows.slice(0, 3);
  const maxVisibleFields = 5;
  const startFieldIndex = Math.max(0, selectedFields.length - maxVisibleFields);
  const visibleFields = selectedFields.slice(startFieldIndex);

  return (
    <div className="stack space-y-8">
      {/* Table Preview at the top */}
      <div className="w-full">
        <div className="overflow-x-auto rounded-md border border-border-muted bg-white shadow-sm min-w-0">
          <Table>
            <TableHeader>
              <TableRow className="border-b-2">
                {/* All columns - highlight email column */}
                {columns.map((col, idx) => {
                  const isEmailCol = col === emailColumn;
                  return (
                    <TableHead
                      key={idx}
                      className={cn(
                        "transition-all duration-700 relative px-6 py-4",
                        isEmailCol
                          ? "gradient-fire text-white font-medium text-body-medium heat-glow"
                          : "bg-background-lighter font-medium text-body-medium",
                        !isEmailCol && step >= 2 && "",
                      )}
                    >
                      <span className="text-black-alpha-88">{col}</span>
                    </TableHead>
                  );
                })}
                {/* Preview columns for selected fields */}
                {step >= 2 &&
                  visibleFields.map((field, idx) => (
                    <TableHead
                      key={`new-${idx}`}
                      className={cn(
                        "font-medium transition-all duration-700 bg-background-lighter text-accent-black text-body-medium px-6 py-4",
                        "animate-in fade-in slide-in-from-right-2",
                      )}
                      style={{
                        animationDelay: `${idx * 100}ms`,
                        animationFillMode: "backwards",
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-black-alpha-88">
                          {field.displayName}
                        </span>
                      </div>
                    </TableHead>
                  ))}
                {step >= 2 && selectedFields.length > maxVisibleFields && (
                  <TableHead className="text-center text-black-alpha-56 animate-in fade-in duration-700 text-body-medium px-6 py-4">
                    +{selectedFields.length - maxVisibleFields} more
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((row, rowIdx) => (
                <TableRow key={rowIdx} className="group">
                  {/* All columns data - highlight email column */}
                  {columns.map((col, colIdx) => {
                    const isEmailCol = col === emailColumn;
                    const cellValue = row[col] || "";

                    if (isEmailCol) {
                      const email = cellValue.trim();
                      const isValidEmail = email && EMAIL_REGEX.test(email);
                      return (
                        <TableCell
                          key={colIdx}
                          className={cn(
                            "bg-heat-8 transition-all duration-700 px-6 py-4 group/email",
                            "text-accent-black",
                          )}
                        >
                          <div className="flex items-center gap-2 relative">
                            <button
                              onClick={async () => {
                                if (email) {
                                  await navigator.clipboard.writeText(email);
                                  toast.success("Email copied to clipboard");
                                }
                              }}
                              className="absolute left-0 opacity-0 group-hover/email:opacity-100 transition-opacity text-gray-500 hover:text-gray-700 z-10"
                              title="Copy email"
                            >
                              <Copy size={14} />
                            </button>
                            <span
                              className={cn(
                                "text-body-medium truncate block max-w-[200px] font-medium group-hover/email:translate-x-5 transition-transform",
                                isValidEmail
                                  ? "text-accent-black email-valid"
                                  : email
                                    ? "text-accent-crimson email-invalid"
                                    : "text-black-alpha-40 email-empty",
                              )}
                            >
                              {email || "-"}
                            </span>
                          </div>
                        </TableCell>
                      );
                    }

                    return (
                      <TableCell
                        key={colIdx}
                        className={cn(
                          "transition-all duration-700 bg-background-base px-6 py-4",
                          step >= 2 && "",
                        )}
                      >
                        <span className="text-body-medium truncate block min-w-[100px] text-black-alpha-64">
                          {cellValue || "-"}
                        </span>
                      </TableCell>
                    );
                  })}
                  {/* Preview cells for selected fields */}
                  {step >= 2 &&
                    visibleFields.map((field, idx) => (
                      <TableCell
                        key={`new-${idx}`}
                        className={cn(
                          "transition-all duration-700 px-6 py-4 bg-white",
                          "animate-in fade-in slide-in-from-right-2",
                        )}
                        style={{
                          animationDelay: `${idx * 100 + rowIdx * 50}ms`,
                          animationFillMode: "backwards",
                        }}
                      >
                        <div className="h-5 rounded-full loading-cell" />
                      </TableCell>
                    ))}
                  {step >= 2 && selectedFields.length > maxVisibleFields && (
                    <TableCell className="text-center text-black-alpha-40 animate-in fade-in duration-700 px-6 py-4">
                      ...
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {!showAllRows && rows.length > 3 && (
          <button
            onClick={() => setShowAllRows(true)}
            className="text-body-medium text-gray-600 hover:text-gray-900 mt-3 font-medium transition-colors"
          >
            Show {rows.length - 3} more rows →
          </button>
        )}
        {showAllRows && (
          <button
            onClick={() => setShowAllRows(false)}
            className="text-body-medium text-gray-600 hover:text-gray-900 mt-3 font-medium transition-colors"
          >
            Show less
          </button>
        )}
      </div>

      {/* Step content below */}
      <div className="w-full">
        <AnimatePresence mode="wait">
        {/* Step 1: Email column selection */}
        {step === 1 && (
          <motion.div
            key="step-1"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.4, ease: "easeInOut" }}
            className="stack space-y-8"
          >
            <Card className="p-16 border-gray-200 rounded-8">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-12">
                  <h3 className="text-body-medium text-gray-900">
                    {emailColumn
                      ? "Email Column Detected"
                      : "Select Email Column"}
                  </h3>
                  {emailColumn ? (
                    <>
                      <span className="text-body-medium bg-gray-100 px-8 py-4 rounded-6 border border-gray-200 text-gray-700">
                        {emailColumn}
                      </span>
                      {!showEmailDropdown && (
                        <button
                          onClick={() => setShowEmailDropdown(true)}
                          className="text-body-small text-gray-600 hover:text-gray-900 hover:underline transition-colors"
                        >
                          Change
                        </button>
                      )}
                      {showEmailDropdown && (
                        <Select
                          value={emailColumn}
                          onValueChange={(value) => {
                            setEmailColumn(value);
                            setShowEmailDropdownStep1(false);
                          }}
                        >
                          <SelectTrigger className="h-32 w-[200px] border-gray-200 focus:border-gray-400">
                            <SelectValue placeholder="Change" />
                          </SelectTrigger>
                          <SelectContent className="bg-white border-gray-200">
                            {columns.map((col) => (
                              <SelectItem
                                key={col}
                                value={col}
                                className="text-body-medium"
                              >
                                {col}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </>
                  ) : (
                    <Select
                      value={emailColumn}
                      onValueChange={(value) => setEmailColumn(value)}
                    >
                      <SelectTrigger className="h-32 w-[200px] border-gray-200 focus:border-gray-400">
                        <SelectValue
                          placeholder="Email Column"
                          className="text-body-medium"
                        />
                      </SelectTrigger>
                      <SelectContent className="bg-white border-gray-200">
                        {columns.map((col) => (
                          <SelectItem
                            key={col}
                            value={col}
                            className="text-body-medium"
                          >
                            {col}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <button
                  onClick={() => setStep(2)}
                  disabled={!emailColumn}
                  className="rounded-8 px-10 py-6 gap-4 text-body-medium text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </Card>

            {/* Skip List Warning */}
            {emailColumn &&
              (() => {
                const commonDomains = [
                  "gmail.com",
                  "yahoo.com",
                  "hotmail.com",
                  "outlook.com",
                  "aol.com",
                  "icloud.com",
                ];
                const skippableEmails = rows.filter((row) => {
                  const email = row[emailColumn]?.toLowerCase();
                  if (!email) return false;
                  const domain = email.split("@")[1];
                  return domain && commonDomains.includes(domain);
                });

                if (skippableEmails.length === 0) return null;

                return (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-start rounded-md gap-6 p-8 border border-gray-200 bg-gray-100">
                    <AlertCircle className="h-16 w-16 flex-shrink-0 text-orange-600" />

                    <div className="text-body-medium text-accent-black">
                      <strong>{skippableEmails.length} emails</strong> from
                      common providers (Gmail, Yahoo, etc.) will be
                      automatically skipped to save API calls. These are
                      typically personal emails without company information.
                    </div>
                  </div>
                );
              })()}
          </motion.div>
        )}

        {/* Email column info for step 2+ */}
        {step >= 2 && (
          <Card className="mb-8 p-6 bg-white border-gray-200 rounded-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="text-body-medium font-medium text-gray-900">
                  Email Column:
                </span>
                <span className="text-body-medium bg-gray-50 px-4 py-2 rounded-md border border-gray-200 text-gray-700">
                  {emailColumn}
                </span>
              </div>
              {!showEmailDropdown && (
                <button
                  onClick={() => setShowEmailDropdown(true)}
                  className="text-body-medium text-gray-600 hover:text-gray-900 transition-colors font-medium"
                >
                  Change
                </button>
              )}
              {showEmailDropdown && (
                <Select
                  value={emailColumn}
                  onValueChange={(value) => {
                    setEmailColumn(value);
                    setShowEmailDropdown(false);
                  }}
                >
                  <SelectTrigger className="h-full w-[200px] bg-white">
                    <SelectValue placeholder="Email Column" />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-border-muted">
                    {columns.map((col) => (
                      <SelectItem
                        key={col}
                        value={col}
                        className="text-body-medium"
                      >
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </Card>
        )}

        {/* Step 2: Field Selection */}
        {step === 2 && (
          <motion.div
            key="step-2"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.4, ease: "easeInOut" }}
            className="space-y-24"
          >
            {/* Header Section */}
            <div className="flex items-start justify-between mb-16">
              <div>
                <h3 className="text-body-medium font-semibold text-gray-900 mb-4">
                  Select fields to enrich
                </h3>
                <p className="text-body-medium text-gray-600">
                  Choose up to 10 fields to add to your data
                </p>
              </div>
              <div className="flex items-center gap-2 px-12 py-8 bg-gray-100 rounded-full">
                <span className="text-body-medium font-semibold text-gray-900">
                  {selectedFields.length} / 10
                </span>
              </div>
            </div>

            {/* Preset fields */}
            <Card className="p-16 border-gray-200 bg-white rounded-8">
              <Label className="text-body-medium font-semibold text-gray-900 mb-12 block">
                Quick add fields
              </Label>
              <div className="flex flex-wrap gap-6">
                {PRESET_FIELDS.map((field) => {
                  const isSelected = selectedFields.find(
                    (f) => f.name === field.name,
                  );
                  return (
                    <button
                      key={field.name}
                      disabled={selectedFields.length >= 10 && !isSelected}
                      onClick={() =>
                        isSelected
                          ? handleRemoveField(field.name)
                          : handleAddField(field)
                      }
                      className={cn(
                        "rounded-6 px-6 py-4 text-body-medium transition-colors flex items-center gap-2",
                        isSelected
                          ? "bg-gray-900 text-white hover:bg-gray-800"
                          : "text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6",
                        selectedFields.length >= 10 &&
                          !isSelected &&
                          "opacity-50 cursor-not-allowed",
                      )}
                    >
                      {field.displayName}
                      {isSelected && <X size={14} />}
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* Add additional fields section */}
            <Card className="p-16 border-gray-200 bg-white rounded-8">
              <Label className="mb-12 block text-body-medium font-semibold text-gray-900">
                Add additional fields
              </Label>

              <div className="space-y-8">
                {/* Natural Language Card */}
                <div className="border rounded-6 border-gray-200 bg-gray-50">
                  <button
                    onClick={() =>
                      setShowNaturalLanguage(!showNaturalLanguage)
                    }
                    className="w-full flex items-center justify-between p-12 text-left transition-colors hover:bg-gray-100"
                  >
                    <span className="flex items-center gap-6 font-medium text-body-medium text-gray-900">
                      Add with natural language
                    </span>
                    {showNaturalLanguage ? (
                      <ChevronUp size={14} className="text-gray-600" />
                    ) : (
                      <ChevronDown size={14} className="text-gray-600" />
                    )}
                  </button>

                  {showNaturalLanguage && (
                    <div className="px-12 pb-12 space-y-8 border-t border-gray-200">
                      <div className="pt-12">
                        <Textarea
                          placeholder="e.g., 'CEO name, company mission statement, main product categories'"
                          value={naturalLanguageInput}
                          onChange={(e) =>
                            setNaturalLanguageInput(e.target.value)
                          }
                          rows={3}
                          className="border-gray-200 focus:border-gray-400 bg-white text-body-small resize-none"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          onClick={handleGenerateFields}
                          disabled={
                            !naturalLanguageInput.trim() || isGenerating
                          }
                          className="rounded-8 px-10 py-6 gap-4 text-body-medium text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isGenerating ? "Generating..." : "Generate Fields"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Manual Add Card */}
                <div className="border rounded-6 border-gray-200 bg-gray-50">
                  <button
                    onClick={() => setShowManualAdd(!showManualAdd)}
                    className="w-full flex items-center justify-between p-12 text-left transition-colors hover:bg-gray-100"
                  >
                    <span className="flex items-center gap-6 font-medium text-body-medium text-gray-900">
                      <Plus size={14} className="text-gray-600" />
                      Add manually
                    </span>
                    {showManualAdd ? (
                      <ChevronUp size={14} className="text-gray-600" />
                    ) : (
                      <ChevronDown size={14} className="text-gray-600" />
                    )}
                  </button>

                  {showManualAdd && (
                    <div className="px-12 pb-12 space-y-8 border-t border-gray-200">
                      <div className="pt-12 space-y-8">
                        <Input
                          placeholder="Field name"
                          value={customField.name}
                          onChange={(e) =>
                            setCustomField({
                              ...customField,
                              name: e.target.value,
                            })
                          }
                          className="w-full border-gray-200 focus:border-gray-400 bg-white text-body-small h-32"
                        />
                        <Textarea
                          placeholder="Field description"
                          value={customField.description}
                          onChange={(e) =>
                            setCustomField({
                              ...customField,
                              description: e.target.value,
                            })
                          }
                          rows={2}
                          className="w-full border-gray-200 focus:border-gray-400 bg-white text-body-small resize-none"
                        />
                        <Select
                          value={customField.type}
                          onValueChange={(
                            value: "string" | "number" | "boolean" | "array",
                          ) => setCustomField({ ...customField, type: value })}
                        >
                          <SelectTrigger className="w-full h-32 border-gray-200 focus:border-gray-400 text-body-small">
                            <SelectValue placeholder="Text" />
                          </SelectTrigger>
                          <SelectContent className="bg-white border-gray-200 z-50">
                            <SelectItem value="string" className="text-body-small">
                              Text
                            </SelectItem>
                            <SelectItem value="number" className="text-body-small">
                              Number
                            </SelectItem>
                            <SelectItem value="boolean" className="text-body-small">
                              Boolean
                            </SelectItem>
                            <SelectItem value="array" className="text-body-small">
                              List
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex justify-end">
                        <button
                          onClick={handleAddCustomField}
                          disabled={!customField.name || !customField.description}
                          className="rounded-8 px-10 py-6 gap-4 text-body-medium text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Add Field
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </Card>

            {/* Suggested fields */}
            {suggestedFields.length > 0 && (
              <Card className="p-16 border-gray-200 bg-white rounded-8">
                <Label className="text-body-medium font-semibold text-gray-900 mb-12 block">
                  Suggested fields
                </Label>
                <div className="space-y-8">
                  {suggestedFields.map((field, idx) => (
                    <div
                      key={idx}
                      className="p-12 border border-gray-200 bg-gray-50 rounded-6 suggested-field-card"
                      style={{
                        animationDelay: `${idx * 100}ms`,
                        animationFillMode: "backwards",
                      }}
                    >
                      <div className="flex justify-between items-start gap-12">
                        <div className="flex-1">
                          <p className="font-medium text-body-medium text-gray-900">
                            {field.displayName}
                          </p>
                          <p className="text-body-medium text-gray-600 mt-2">
                            {field.description}
                          </p>
                        </div>
                        <div className="flex gap-6 flex-shrink-0">
                          <button
                            onClick={() => {
                              handleAddField(field);
                              setSuggestedFields(
                                suggestedFields.filter((_, i) => i !== idx),
                              );
                            }}
                            className="px-12 py-6 bg-gray-900 text-white text-body-medium rounded-6 hover:bg-gray-800 transition-colors font-medium whitespace-nowrap"
                          >
                            Accept
                          </button>
                          <button
                            onClick={() =>
                              setSuggestedFields(
                                suggestedFields.filter((_, i) => i !== idx),
                              )
                            }
                            className="px-12 py-6 bg-white border border-gray-200 text-gray-700 text-body-medium rounded-6 hover:bg-gray-50 transition-colors font-medium whitespace-nowrap"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Navigation Buttons */}
            <div className="flex justify-between pt-16">
              <button
                onClick={() => setStep(1)}
                className="rounded-8 px-10 py-6 gap-4 text-body-medium text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center"
              >
                <ArrowLeft style={{ width: '20px', height: '20px' }} />
                Back
              </button>
              <button
                onClick={() => onStartEnrichment(emailColumn, selectedFields)}
                disabled={selectedFields.length === 0}
                className="rounded-8 px-10 py-6 gap-4 text-body-medium text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Start Enrichment
              </button>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </div>
  );
}
