"use client";

import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { CSVRow } from "@/lib/types";
import { Upload, Download, AtSign, InfinityIcon } from "lucide-react";
import Button from "@/components/shared/button/button";
import Link from "next/link";
import { FIRE_ENRICH_CONFIG } from "./config";

interface CSVUploaderProps {
  onUpload: (rows: CSVRow[], columns: string[]) => void;
}

export function CSVUploader({ onUpload }: CSVUploaderProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const processCSV = useCallback(
    (file: File) => {
      setIsProcessing(true);
      setError(null);
      setFileName(file.name);

      Papa.parse(file, {
        complete: (results) => {
          if (results.errors.length > 0) {
            setError(`CSV parsing error: ${results.errors[0].message}`);
            setIsProcessing(false);
            return;
          }

          if (!results.data || results.data.length === 0) {
            setError("CSV file is empty");
            setIsProcessing(false);
            return;
          }

          // Get headers from first row
          const headers = Object.keys(results.data[0] as object);
          const rows = results.data as CSVRow[];

          // Filter out empty rows
          const validRows = rows.filter((row) =>
            Object.values(row).some(
              (value) => value && String(value).trim() !== "",
            ),
          );

          if (validRows.length === 0) {
            setError("No valid data rows found in CSV");
            setIsProcessing(false);
            return;
          }

          setIsProcessing(false);
          onUpload(validRows, headers);
        },
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim(),
        transform: (value) => value.trim(),
      });
    },
    [onUpload],
  );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        processCSV(acceptedFiles[0]);
      }
    },
    [processCSV],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "text/csv": [".csv"],
      "application/vnd.ms-excel": [".csv"],
    },
    maxFiles: 1,
  });

  return (
    <div className="w-full">
      <div
        {...getRootProps()}
        className={`
          relative overflow-hidden
          border-2 border-dashed rounded-xl text-center cursor-pointer
          transition-all duration-300 ease-out min-h-[150px]
          flex flex-col items-center justify-center
          ${
            isDragActive
              ? "border-heat-100 bg-heat-4 shadow-xl"
              : "border-border-muted hover:border-heat-100 bg-accent-white hover:bg-heat-4 hover:shadow-lg"
          }
          ${isProcessing ? "opacity-50 cursor-not-allowed" : ""}
        `}
      >
        <input {...getInputProps()} disabled={isProcessing} />

        {/* Background pattern */}
        <div className="absolute inset-0 opacity-3">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(circle at 2px 2px, var(--heat-100) 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />
        </div>

        <div className="flex flex-col items-center justify-center relative z-10">
          {isProcessing ? (
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center gap-3">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-heat-100 rounded-full animate-pulse" />
                  <div className="w-2 h-2 bg-heat-100 rounded-full animate-pulse animation-delay-150" />
                  <div className="w-2 h-2 bg-heat-100 rounded-full animate-pulse animation-delay-300" />
                </div>
                <span className="text-body-large font-medium text-accent-black">
                  Processing...
                </span>
              </div>
              <p className="text-sm text-black-alpha-64">{fileName}</p>
            </div>
          ) : isDragActive ? (
            <div className="animate-fade-in">
              <p
                className="text-title-h5 font-semibold mb-1"
                style={{ color: "var(--heat-100)" }}
              >
                Drop it here!
              </p>
              <p className="text-sm text-black-alpha-64">
                We&apos;ll start processing immediately
              </p>
            </div>
          ) : fileName ? (
            <div className="text-center">
              <p className="text-body-large font-medium text-accent-black mb-1">
                {fileName}
              </p>
              <p className="text-sm text-black-alpha-64">
                File ready for processing
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-title-h5 font-medium text-accent-black mb-2">
                Drag & drop your CSV file here
              </p>
              <p className="text-sm text-black-alpha-64 my-4">
                or click to browse from your computer
              </p>
              <Button className="inline-flex items-center mt-16 transition-all duration-200">
                <Upload className="w-16 h-16" />
                <span className="font-medium">Select CSV File</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl animate-fade-in shadow-sm">
          <p className="font-semibold mb-1 text-accent-crimson">Error:</p>
          <p className="text-sm whitespace-pre-line text-red-600">{error}</p>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full p-4 mt-4">
        {/* Download Sample */}
        <Button
          variant="primary"
          className="flex flex-col items-start justify-center gap-1 p-4 text-left w-full h-full"
        >
          <Link
            href="/sample-data.csv"
            download="sample-data.csv"
            className="flex flex-col"
          >
            <div className="flex items-center gap-2">
              <Download className="w-16 h-16 shrink-0" />
              <span className="font-medium">Download Sample</span>
            </div>
            <span className="text-sm opacity-80">Try our Sample CSV File</span>
          </Link>
        </Button>

        {/* Email Required */}
        <Button
          variant="secondary"
          className="flex flex-col items-start justify-center gap-1 p-4 text-left w-full h-full"
        >
          <span className="font-medium">Email Required</span>
          <span className="text-sm opacity-80">Must contain email address</span>
        </Button>
      </div>
    </div>
  );
}
