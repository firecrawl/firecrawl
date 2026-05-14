'use client';

import { useEffect } from 'react';
import { CSVRow, EnrichmentField, RowEnrichmentResult } from '@/lib/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExternalLink, Mail, CheckCircle, XCircle, ChevronDown } from 'lucide-react';

interface DetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  row: CSVRow;
  result: RowEnrichmentResult | undefined;
  fields: EnrichmentField[];
  emailColumn?: string;
}

export function DetailModal({ isOpen, onClose, row, result, fields, emailColumn }: DetailModalProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }
    
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Find the company name and website URL
  const companyNameField = fields.find(f => f.name === 'company_name' || f.displayName === 'Company Name');
  const companyName = companyNameField && result?.enrichments[companyNameField.name]?.value || 'Company Details';
  
  // Extract website URL from enrichments or original data
  const websiteUrlValue = result?.enrichments['website']?.value || 
                         result?.enrichments['company_website']?.value || 
                         row['website'] || 
                         row['company_website'] || 
                         '';
  const websiteUrl = typeof websiteUrlValue === 'string' ? websiteUrlValue : '';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden bg-white">
        <DialogHeader className="bg-gradient-to-r from-gray-900 to-gray-800 text-white -m-6 mb-0 p-4 rounded-t-lg">
          <DialogTitle className="text-lg font-semibold">
            <div>
              {companyName}
              {websiteUrl && (
                <a 
                  href={websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-gray-300 hover:text-white text-xs mt-0.5 transition-colors ml-3"
                >
                  <ExternalLink className="w-3 h-3" />
                  Visit Website
                </a>
              )}
            </div>
          </DialogTitle>
        </DialogHeader>
        
        <div className="overflow-y-auto max-h-[calc(80vh-100px)] mt-4">
          {/* Email and Basic Info */}
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-gray-400" />
              <span className="text-gray-900 font-medium text-sm">{emailColumn ? row[emailColumn] : Object.values(row)[0]}</span>
            </div>
          </div>
          
          {/* Enriched Data Section */}
          {result && (
            <div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {fields.map(field => {
                  const enrichment = result.enrichments[field.name];
                  if (!enrichment) return null;
                  
                  // Skip company description as we'll show it separately
                  if (field.name === 'company_description' || field.displayName === 'Company Description') {
                    return null;
                  }
                  
                  return (
                    <div key={field.name} className="bg-gray-50 rounded-lg p-3">
                      <div className="flex items-start justify-between mb-2">
                        <h4 className="font-medium text-gray-900 text-sm">{field.displayName}</h4>
                        <div className="flex items-center gap-2">
                          {(enrichment.source || enrichment.sourceContext) && (
                            <div className="flex flex-wrap gap-1">
                              {enrichment.sourceContext && enrichment.sourceContext.length > 0 ? (
                                enrichment.sourceContext.map((ctx, idx) => (
                                  <a
                                    key={idx}
                                    href={ctx.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-200 text-gray-600 hover:bg-gray-300"
                                    title={ctx.snippet || 'View source'}
                                  >
                                    <ExternalLink className="w-3 h-3 mr-0.5" />
                                    {new URL(ctx.url).hostname.replace('www.', '')}
                                  </a>
                                ))
                              ) : enrichment.source && (
                                enrichment.source.split(', ').map((url, idx) => (
                                  <a
                                    key={idx}
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-200 text-gray-600 hover:bg-gray-300"
                                  >
                                    <ExternalLink className="w-3 h-3 mr-0.5" />
                                    {(() => {
                                      try {
                                        return new URL(url).hostname.replace('www.', '');
                                      } catch {
                                        return 'Source';
                                      }
                                    })()}
                                  </a>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-gray-700 text-sm">
                        {field.type === 'boolean' ? (
                          <div className="flex items-center gap-1">
                            {enrichment.value === true || enrichment.value === 'true' || enrichment.value === 'Yes' ? (
                              <>
                                <CheckCircle className="w-4 h-4 text-green-600" />
                                <span className="text-green-700 font-medium">Yes</span>
                              </>
                            ) : (
                              <>
                                <XCircle className="w-4 h-4 text-red-600" />
                                <span className="text-red-700 font-medium">No</span>
                              </>
                            )}
                          </div>
                        ) : field.type === 'array' && Array.isArray(enrichment.value) ? (
                          <ul className="space-y-0.5 text-sm">
                            {enrichment.value.map((item, idx) => (
                              <li key={idx} className="flex items-start gap-1">
                                <span className="text-blue-600">•</span>
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>{enrichment.value || '-'}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              
              {/* Company Description - Full Width */}
              {fields.map(field => {
                const enrichment = result.enrichments[field.name];
                if (!enrichment || (field.name !== 'company_description' && field.displayName !== 'Company Description')) {
                  return null;
                }
                
                return (
                  <div key={field.name} className="mt-4 bg-blue-50 rounded-lg p-4">
                    <div className="flex items-start justify-between mb-2">
                      <h4 className="font-medium text-gray-900 text-sm">
                        {field.displayName}
                      </h4>
                      {enrichment.source && (
                        <div className="text-xs space-y-1">
                          {enrichment.source.split(', ').map((url, idx) => (
                            <a 
                              key={idx}
                              href={url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="block text-gray-600 hover:text-blue-600"
                            >
                              {(() => {
                                try {
                                  return new URL(url).hostname.replace('www.', '');
                                } catch {
                                  return 'View source';
                                }
                              })()}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="text-gray-700 text-sm leading-relaxed">{enrichment.value}</p>
                  </div>
                );
              })}
            </div>
          )}
          
          {/* Original Data Section - Collapsed by default */}
          <details className="mt-4 border-t pt-3">
            <summary className="cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1">
              <ChevronDown className="w-3 h-3" />
              View Original Data
            </summary>
            <div className="mt-2 bg-gray-50 rounded p-2 space-y-1">
              {Object.entries(row).map(([key, value]) => (
                <div key={key} className="flex text-xs">
                  <span className="font-medium text-gray-600 w-28">{key}:</span>
                  <span className="text-gray-900">{value}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}