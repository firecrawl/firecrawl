'use client';

import { useState, useRef, useEffect } from 'react';
import { ExternalLink, ChevronDown } from 'lucide-react';

interface SourceContextTooltipProps {
  sources: Array<{
    url: string;
    snippet: string;
    confidence?: number;
  }>;
  value: string | number | boolean | string[];
  legacySource?: string;
  sourceCount?: number;
  corroboration?: {
    evidence: Array<{
      value: string | number | boolean | string[];
      source_url: string;
      exact_text: string;
      confidence: number;
    }>;
    sources_agree: boolean;
  };
  confidence?: number;
}

export function SourceContextTooltip({ sources, legacySource, sourceCount, corroboration, confidence }: SourceContextTooltipProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  
  // Listen for close events from other tooltips
  useEffect(() => {
    const handleCloseOthers = (event: CustomEvent) => {
      if (event.detail.excludeRef !== buttonRef.current) {
        setIsExpanded(false);
      }
    };
    
    window.addEventListener('close-other-tooltips' as unknown as keyof WindowEventMap, handleCloseOthers as EventListener);
    return () => window.removeEventListener('close-other-tooltips' as unknown as keyof WindowEventMap, handleCloseOthers as EventListener);
  }, []);
  
  // Debug log
  if (isExpanded) {
    console.log('SourceContextTooltip data:', {
      sources,
      corroboration,
      legacySource
    });
  }
  
  const getDomain = (url: string) => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url;
    }
  };
  
  // Filter out blocked sites
  const blockedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com'];
  
  const filterSources = (sourceList: Array<{ url: string; snippet: string }>) => {
    return sourceList.filter(source => {
      const domain = getDomain(source.url).toLowerCase();
      return !blockedDomains.some(blocked => domain.includes(blocked));
    });
  };
  
  // Use legacy source if no context available
  const unfilteredSources = sources && sources.length > 0 ? sources : 
    legacySource ? legacySource.split(', ').map(url => ({ url, snippet: '' })) : [];
    
  const displaySources = filterSources(unfilteredSources);
  
  // Don't render if no sources
  if (displaySources.length === 0 && !sourceCount) return null;
  
  // Always show info icon for consistency
  const hasSnippets = displaySources.some(s => s.snippet && s.snippet.length > 0);
  
  return (
    <div className="inline-block relative">
      <button
        ref={buttonRef}
        onClick={() => {
          setIsExpanded(!isExpanded);
          // Close other tooltips by dispatching a custom event
          if (!isExpanded) {
            window.dispatchEvent(new CustomEvent('close-other-tooltips', { detail: { excludeRef: buttonRef.current } }));
          }
        }}
        className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors whitespace-nowrap"
        title={hasSnippets ? "View source quotes" : "View sources"}
      >
        <ExternalLink className="w-3 h-3 mr-0.5" />
        {sourceCount || displaySources.length} {(sourceCount || displaySources.length) === 1 ? 'source' : 'sources'}
        <ChevronDown 
          className={`w-3 h-3 ml-0.5 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>
      
      {isExpanded && (
        <div 
          ref={modalRef}
          className="absolute z-[9999] bg-white border border-gray-200 rounded-lg shadow-lg p-3 space-y-2 max-w-md left-0 mt-2" 
          style={{ 
            minWidth: '300px',
            // Position above if near bottom of viewport
            bottom: typeof window !== 'undefined' && 
                   buttonRef.current && 
                   buttonRef.current.getBoundingClientRect().bottom > window.innerHeight - 300 
                   ? '100%' 
                   : 'auto',
            top: typeof window !== 'undefined' && 
                 buttonRef.current && 
                 buttonRef.current.getBoundingClientRect().bottom > window.innerHeight - 300 
                 ? 'auto' 
                 : '100%',
            marginBottom: typeof window !== 'undefined' && 
                         buttonRef.current && 
                         buttonRef.current.getBoundingClientRect().bottom > window.innerHeight - 300 
                         ? '8px' 
                         : '0'
          }}>
          
          <div className="mb-2 pb-2 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-gray-700">
                Found in {displaySources.length} {displaySources.length === 1 ? 'source' : 'sources'}
              </h4>
              {confidence && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  confidence >= 0.8 ? 'bg-green-100 text-green-700' :
                  confidence >= 0.5 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {Math.round(confidence * 100)}% confident
                </span>
              )}
            </div>
            {corroboration && (
              <p className={`text-xs mt-1 ${
                corroboration.sources_agree ? 'text-green-600' : 'text-amber-600'
              }`}>
                Sources {corroboration.sources_agree ? 'agree' : 'have different values'}
              </p>
            )}
          </div>
          
          <div className="max-h-64 overflow-y-auto space-y-3">
            {displaySources.map((source, idx) => (
              <div key={idx} className="border border-gray-100 rounded-lg p-3 hover:border-gray-200 transition-colors">
                {source.snippet && source.snippet.length > 0 ? (
                  <div>
                    {source.snippet && source.snippet.trim() !== '' && (
                      <p className="text-xs text-gray-700 mb-2 italic leading-relaxed">
                        &quot;{source.snippet}&quot;
                      </p>
                    )}
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      {getDomain(source.url)}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                ) : (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                  >
                    {getDomain(source.url)}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}