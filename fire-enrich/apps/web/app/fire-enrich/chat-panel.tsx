"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Card } from "@/components/ui/card";
import Input from "@/components/ui/input";
import Button from "@/components/shared/button/button";
import {
  X,
  Activity,
  CheckCircle,
  AlertCircle,
  Info,
  User,
  Bot,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// Add keyframe animation
if (typeof window !== "undefined") {
  const style = document.createElement("style");
  style.textContent = `
    @keyframes slideInFade {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  `;
  if (!document.head.querySelector('style[data-chat-animations]')) {
    style.setAttribute('data-chat-animations', 'true');
    document.head.appendChild(style);
  }
}

export interface ChatMessage {
  id: string;
  message: string;
  type: "info" | "success" | "warning" | "agent" | "user" | "assistant";
  timestamp: number;
  rowIndex?: number;
  sourceUrl?: string;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => Promise<void>;
  onStopQuery?: () => void;
  isProcessing?: boolean;
  totalRows?: number;
  results?: Map<number, any>;
  onExpandedChange?: (expanded: boolean) => void;
}

export function ChatPanel({
  messages,
  onSendMessage,
  onStopQuery,
  isProcessing = false,
  totalRows = 0,
  results = new Map(),
  onExpandedChange,
}: ChatPanelProps) {
  const [inputValue, setInputValue] = useState("");
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set()); // Start with all rows collapsed
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Group messages by row
  const messagesByRow = messages.reduce((acc, msg) => {
    if (msg.rowIndex !== undefined) {
      if (!acc[msg.rowIndex]) {
        acc[msg.rowIndex] = [];
      }
      acc[msg.rowIndex].push(msg);
    } else {
      // Non-row messages (general chat)
      if (!acc[-1]) {
        acc[-1] = [];
      }
      acc[-1].push(msg);
    }
    return acc;
  }, {} as Record<number, ChatMessage[]>);

  // Get processing rows for visual indicators (not for auto-expansion)
  const processingRows = useMemo(() => {
    const rows: number[] = [];
    for (let i = 0; i < totalRows; i++) {
      const result = results.get(i);
      if (result?.status === 'processing') {
        rows.push(i);
      }
    }
    return rows;
  }, [totalRows, results]);

  // Get pending rows (queued but not yet started)
  const pendingRows = useMemo(() => {
    const rows: number[] = [];
    for (let i = 0; i < totalRows; i++) {
      const result = results.get(i);
      if (result?.status === 'pending') {
        rows.push(i);
      }
    }
    return rows;
  }, [totalRows, results]);

  // Notify parent when expanded state changes
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  // Check if user is at bottom of scroll
  const handleScroll = () => {
    if (messagesContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50; // 50px threshold
      setShouldAutoScroll(isAtBottom);
    }
  };

  // Auto-scroll to bottom only if user is already at bottom
  useEffect(() => {
    if (shouldAutoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, shouldAutoScroll]);

  const toggleRow = (rowIndex: number) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(rowIndex)) {
        newSet.delete(rowIndex);
      } else {
        newSet.add(rowIndex);
      }
      return newSet;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isProcessing) return;

    const message = inputValue.trim();
    setInputValue("");
    await onSendMessage(message);
  };

  const getMessageIcon = (type: ChatMessage["type"]) => {
    const iconStyle = { width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' };
    switch (type) {
      case "agent":
        return <Activity style={iconStyle} />;
      case "success":
        return <CheckCircle style={iconStyle} />;
      case "warning":
        return <AlertCircle style={iconStyle} />;
      case "user":
        return <User style={iconStyle} />;
      case "assistant":
        return <Bot style={iconStyle} />;
      default:
        return <Info style={iconStyle} />;
    }
  };

  const getMessageIconColor = (type: ChatMessage["type"]) => {
    // All icons use orange color
    return "text-orange-600";
  };

  if (!isExpanded) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <Button
          onClick={() => setIsExpanded(true)}
          variant="primary"
          size="default"
          className="shadow-lg"
        >
          <Activity size={16} className="mr-2" />
          Co-Pilot
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed right-16 top-[88px] bottom-4 w-[420px] bg-white border border-gray-200 shadow-xl z-40 flex flex-col rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
        <div className="flex items-center gap-2">
          <span className="text-body-small text-gray-700">Co-Pilot</span>
          {results.size > 0 && (
            <span className="text-body-x-small text-gray-500">
              ({results.size} rows)
            </span>
          )}
        </div>
        <button
          onClick={() => setIsExpanded(false)}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-2 scrollbar-hide"
      >
        {messages.length === 0 ? (
          <div className="text-center text-gray-400 mt-8">
            <p className="text-body-small">Ask me anything about the enrichment</p>
            <p className="text-body-x-small mt-1">
              I can search, scrape, and analyze data for you
            </p>
          </div>
        ) : (
          <>
            {/* Row-based messages grouped in accordions */}
            {Array.from({ length: totalRows }, (_, i) => i).map((rowIndex) => {
                const rowMessages = messagesByRow[rowIndex] || [];
                const result = results.get(rowIndex);
                const isExpanded = expandedRows.has(rowIndex);
                const isSkipped = result?.status === 'skipped';
                const isProcessing = processingRows.includes(rowIndex);
                const isPending = pendingRows.includes(rowIndex);
                const isCompleted = result && ['completed', 'error'].includes(result.status || '');

                // Don't show rows that haven't been processed yet (no result and no messages)
                if (!result && rowMessages.length === 0) return null;

                return (
                  <div
                    key={`row-${rowIndex}`}
                    className={`border rounded-md overflow-hidden transition-all ${
                      isProcessing ? 'border-gray-300 bg-gray-50' : isPending ? 'border-gray-100 bg-gray-25' : 'border-gray-200 bg-white'
                    }`}
                  >
                    <button
                      onClick={() => toggleRow(rowIndex)}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        {isProcessing && (
                          <Loader2 size={16} className="animate-spin text-gray-500 flex-shrink-0" />
                        )}
                        {isPending && !isProcessing && (
                          <div className="w-4 h-4 rounded-full border-2 border-gray-300 flex-shrink-0" />
                        )}
                        {isCompleted && !isProcessing && !isPending && (
                          <CheckCircle size={16} className="text-gray-900 flex-shrink-0" />
                        )}
                        <span className="text-body-small text-gray-900 flex-shrink-0">
                          Row {rowIndex + 1}
                        </span>
                        {!isExpanded && (
                          <>
                            {isSkipped ? (
                              <span className="text-body-x-small text-gray-500 ml-auto">
                                Skipped
                              </span>
                            ) : isPending ? (
                              <span className="text-body-x-small text-gray-400 ml-auto">
                                Queued
                              </span>
                            ) : isCompleted ? (
                              <span className="text-body-x-small text-gray-500 ml-auto">
                                {Object.keys(result.enrichments || {}).length} fields
                              </span>
                            ) : rowMessages.length > 0 ? (
                              <span className="text-body-x-small text-gray-500 ml-auto">
                                {rowMessages.length} updates
                              </span>
                            ) : null}
                          </>
                        )}
                      </div>
                      <div className="flex-shrink-0 ml-2">
                        {isExpanded ? (
                          <ChevronUp size={16} className="text-gray-500" />
                        ) : (
                          <ChevronDown size={16} className="text-gray-500" />
                        )}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3 pt-2 space-y-2 border-t border-gray-200 bg-white">
                        {isSkipped ? (
                          <p className="text-body-x-small leading-relaxed break-words text-gray-700">
                            {result?.error || 'Row skipped - common email provider'}
                          </p>
                        ) : isPending && rowMessages.length === 0 ? (
                          <p className="text-body-x-small leading-relaxed break-words text-gray-400">
                            Queued for processing...
                          </p>
                        ) : rowMessages.length === 0 && !isCompleted ? (
                          <p className="text-body-x-small leading-relaxed break-words text-gray-500">
                            No activity yet
                          </p>
                        ) : (
                          <>
                            {/* Show all processing steps */}
                            {rowMessages.map((msg) => {
                              // Extract domain from sourceUrl if present
                              const getDomain = (url: string) => {
                                try {
                                  return new URL(url).hostname;
                                } catch {
                                  return null;
                                }
                              };

                              const domain = msg.sourceUrl ? getDomain(msg.sourceUrl) : null;
                              const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : null;

                              return (
                                <div
                                  key={msg.id}
                                  className="py-1 animate-in fade-in slide-in-from-right-4 duration-500"
                                  style={{
                                    animation: 'slideInFade 0.5s ease-out forwards'
                                  }}
                                >
                                  {faviconUrl ? (
                                    <div className="flex items-start gap-2">
                                      <img
                                        src={faviconUrl}
                                        alt={`${domain} favicon`}
                                        className="flex-shrink-0 mt-0.5 w-24 h-24 rounded mr-3"
                                      />
                                      <p className="text-body-x-small leading-relaxed break-words text-gray-700 flex-1">
                                        {msg.type === 'agent' && msg.message.includes(':') ? (
                                          <>
                                            <span className="font-semibold">{msg.message.split(':')[0]}:</span>
                                            {msg.message.split(':').slice(1).join(':')}
                                          </>
                                        ) : (
                                          msg.message
                                        )}
                                      </p>
                                    </div>
                                  ) : (
                                    <p className="text-body-x-small leading-relaxed break-words text-gray-700">
                                      {msg.type === 'agent' && msg.message.includes(':') ? (
                                        <>
                                          <span className="font-semibold">{msg.message.split(':')[0]}:</span>
                                          {msg.message.split(':').slice(1).join(':')}
                                        </>
                                      ) : (
                                        msg.message
                                      )}
                                    </p>
                                  )}
                                </div>
                              );
                            })}

                            {/* Show completion summary if completed */}
                            {isCompleted && result && (
                              <div className="space-y-1 pt-2 mt-2 border-t border-gray-200">
                                <p className="text-body-x-small leading-relaxed break-words text-gray-700 font-semibold">
                                  ✓ Completed - {Object.keys(result.enrichments || {}).length} field{Object.keys(result.enrichments || {}).length !== 1 ? 's' : ''} enriched
                                </p>
                                {Object.entries(result.enrichments || {}).slice(0, 5).map(([fieldName, enrichment]) => {
                                  const enrichmentData = enrichment as any;
                                  return (
                                    <p key={fieldName} className="text-body-x-small leading-relaxed break-words text-gray-500">
                                      • {enrichmentData.field || fieldName}: {enrichmentData.value ? String(enrichmentData.value).substring(0, 40) + (String(enrichmentData.value).length > 40 ? '...' : '') : '—'}
                                    </p>
                                  );
                                })}
                                {Object.keys(result.enrichments || {}).length > 5 && (
                                  <p className="text-body-x-small leading-relaxed break-words text-gray-400">
                                    +{Object.keys(result.enrichments || {}).length - 5} more fields
                                  </p>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

            {/* Non-row messages (general chat) */}
            {messagesByRow[-1]?.map((msg) => {
              const isUserMessage = msg.type === 'user';

              return (
                <div
                  key={msg.id}
                  className="py-2 px-3 rounded-md bg-white border border-gray-200"
                >
                  <p className={`text-body-x-small leading-relaxed break-words ${
                    isUserMessage ? 'text-blue-900' : 'text-gray-900'
                  }`}>
                    {msg.message}
                  </p>
                </div>
              );
            })}
          </>
        )}
        {isProcessing && (
          <div className="flex items-center justify-center gap-2 text-gray-500 text-body-small mt-3">
            <Loader2 size={16} className="animate-spin" />
            <span>Thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 border-t border-gray-200 bg-gray-50">
        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Ask a question about the data..."
              disabled={isProcessing}
              className="flex-1"
            />
            {isProcessing ? (
              <button
                type="button"
                onClick={onStopQuery}
                className="flex-shrink-0 p-2 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors"
              >
                <X size={16} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputValue.trim()}
                className="flex-shrink-0 px-10 py-6 rounded-10 bg-gradient-to-br from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.995] shadow-sm hover:shadow-md"
              >
                <svg fill="none" height="16" viewBox="0 0 20 20" width="16" xmlns="http://www.w3.org/2000/svg" className="text-white">
                  <path d="M11.6667 4.79163L16.875 9.99994M16.875 9.99994L11.6667 15.2083M16.875 9.99994H3.125" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"></path>
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
