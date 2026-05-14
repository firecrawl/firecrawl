'use client';

import { useState, useEffect } from 'react';
import { CSVRow } from '@/lib/types';
import { detectEmailColumn, getPreviewData } from '@/lib/utils/email-detection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface CSVPreviewProps {
  rows: CSVRow[];
  columns: string[];
  onEmailColumnConfirmed: (columnName: string) => void;
}

export function CSVPreview({ rows, columns, onEmailColumnConfirmed }: CSVPreviewProps) {
  const [selectedColumn, setSelectedColumn] = useState<string>('');
  const [detectedColumn, setDetectedColumn] = useState<{
    columnName: string | null;
    columnIndex: number;
    confidence: number;
  } | null>(null);

  useEffect(() => {
    const detected = detectEmailColumn(rows, columns);
    setDetectedColumn(detected);
    if (detected.columnName) {
      setSelectedColumn(detected.columnName);
    }
  }, [rows, columns]);

  const previewRows = getPreviewData(rows, 5);
  const hasMoreRows = rows.length > 5;

  const handleConfirm = () => {
    if (selectedColumn) {
      onEmailColumnConfirmed(selectedColumn);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <h3 className="text-label-medium">Email Column Detection</h3>

        {detectedColumn && detectedColumn.columnName && (
          <div className="flex items-center text-body-small">
            <span className="font-medium">Auto-detected:</span>
            <span className="ml-1 font-semibold">{detectedColumn.columnName}</span>
            <span className={`ml-2 ${
              detectedColumn.confidence >= 80 ? 'text-green-600' :
              detectedColumn.confidence >= 50 ? 'text-yellow-600' : 'text-red-600'
            }`}>
              ({detectedColumn.confidence}% confidence)
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <label className="text-body-small font-medium text-gray-700">
            Select email column:
          </label>
          <Select value={selectedColumn} onValueChange={setSelectedColumn}>
            <SelectTrigger className="w-[180px] h-8">
              <SelectValue placeholder="Select column" />
            </SelectTrigger>
            <SelectContent>
              {columns.map((column) => (
                <SelectItem key={column} value={column}>
                  {column}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <h3 className="text-label-medium mb-2">Preview (First 5 Rows)</h3>
        <div className="border border-gray-200 rounded overflow-hidden">
          <div className="overflow-x-auto max-h-60">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column}
                      className={`px-3 py-2 text-left text-label-small uppercase tracking-wider ${
                        column === selectedColumn
                          ? 'text-black bg-gray-100'
                          : 'text-gray-500'
                      }`}
                    >
                      {column}
                      {column === selectedColumn && (
                        <span className="ml-1 text-orange-600">✓</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {previewRows.map((row, index) => (
                  <tr key={index} className="hover:bg-gray-50">
                    {columns.map((column) => (
                      <td
                        key={column}
                        className={`px-3 py-1.5 whitespace-nowrap text-body-small ${
                          column === selectedColumn
                            ? 'font-medium text-gray-900 bg-orange-50'
                            : 'text-gray-500'
                        }`}
                      >
                        <div className="truncate max-w-xs" title={row[column] || '-'}>
                          {row[column] || '-'}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
                {hasMoreRows && (
                  <tr className="bg-gray-50">
                    <td
                      colSpan={columns.length}
                      className="px-3 py-2 text-center text-body-small text-gray-400 italic"
                    >
                      ... and {rows.length - 5} more rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={handleConfirm}
          disabled={!selectedColumn}
          variant="orange"
        >
          Confirm Email Column
        </Button>
      </div>
    </div>
  );
}