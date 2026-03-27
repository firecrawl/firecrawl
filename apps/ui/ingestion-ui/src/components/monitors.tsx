import { useState, useEffect } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

//! Hardcoded values (not recommended for production)
//! Move API calls to a backend proxy for production use
const FIRECRAWL_API_URL = "https://api.firecrawl.dev";
const FIRECRAWL_API_KEY = "fc-YOUR_API_KEY";

interface Schedule {
  id: string;
  name: string | null;
  url: string;
  cron: string;
  mode: string;
  paused: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_result: string | null;
  created_at: string;
}

type View = "list" | "create" | "detail";

export default function MonitorsComponent() {
  const [view, setView] = useState<View>("list");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [formUrl, setFormUrl] = useState("");
  const [formCron, setFormCron] = useState("");
  const [formName, setFormName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);

  // Q&A state
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const authHeaders = {
    Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    "Content-Type": "application/json",
  };

  async function fetchSchedules() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${FIRECRAWL_API_URL}/v1/schedules`, {
        headers: authHeaders,
      });
      const data = await res.json();
      if (data.success) {
        setSchedules(data.schedules);
      } else {
        setError(data.error ?? "Failed to load schedules");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function fetchSchedule(id: string) {
    try {
      const res = await fetch(`${FIRECRAWL_API_URL}/v1/schedules/${id}`, {
        headers: authHeaders,
      });
      const data = await res.json();
      if (data.success) {
        setSelectedSchedule(data.schedule);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (view === "list") fetchSchedules();
  }, [view]);

  useEffect(() => {
    if (view === "detail" && selectedId) {
      fetchSchedule(selectedId);
      setAnswer(null);
      setQuestion("");
      setAskError(null);
    }
  }, [view, selectedId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormLoading(true);
    setFormError(null);
    try {
      const res = await fetch(`${FIRECRAWL_API_URL}/v1/schedules`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          url: formUrl,
          cron: formCron,
          name: formName || undefined,
          mode: "scrape",
          scrapeOptions: { formats: ["markdown"] },
        }),
      });
      const data = await res.json();
      if (res.status === 201 && data.success) {
        setFormUrl("");
        setFormCron("");
        setFormName("");
        setView("list");
      } else {
        setFormError(data.error ?? "Failed to create schedule");
      }
    } catch {
      setFormError("Network error");
    } finally {
      setFormLoading(false);
    }
  }

  async function handleTogglePause(schedule: Schedule) {
    try {
      await fetch(`${FIRECRAWL_API_URL}/v1/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ paused: !schedule.paused }),
      });
      await fetchSchedules();
    } catch {
      // ignore
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch(`${FIRECRAWL_API_URL}/v1/schedules/${id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      setSchedules(prev => prev.filter(s => s.id !== id));
    } catch {
      // ignore
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !question.trim()) return;
    setAsking(true);
    setAnswer(null);
    setAskError(null);
    try {
      const res = await fetch(`${FIRECRAWL_API_URL}/v1/schedules/${selectedId}/ask`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (data.success) {
        setAnswer(data.answer);
      } else {
        setAskError(data.error ?? "Failed to get answer");
      }
    } catch {
      setAskError("Network error");
    } finally {
      setAsking(false);
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
  }

  // ── LIST VIEW ──────────────────────────────────────────────
  if (view === "list") {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Monitors</h1>
          <Button onClick={() => setView("create")}>+ New Monitor</Button>
        </div>

        {loading && <p className="text-muted-foreground text-sm">Loading...</p>}
        {error && <p className="text-red-500 text-sm">{error}</p>}

        {!loading && schedules.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              No monitors yet. Create one to get started.
            </CardContent>
          </Card>
        )}

        {schedules.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Name / URL</th>
                  <th className="text-left px-4 py-3 font-medium">Cron</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Last Run</th>
                  <th className="text-left px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <button
                        className="font-medium text-blue-600 hover:underline text-left"
                        onClick={() => { setSelectedId(s.id); setView("detail"); }}
                      >
                        {s.name ?? s.url}
                      </button>
                      {s.name && (
                        <div className="text-xs text-muted-foreground truncate max-w-xs">{s.url}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{s.cron}</td>
                    <td className="px-4 py-3">
                      {s.paused ? (
                        <span className="text-yellow-600 text-xs font-medium">Paused</span>
                      ) : s.last_run_status === "completed" ? (
                        <span className="text-green-600 text-xs font-medium">✓ OK</span>
                      ) : s.last_run_status === "failed" ? (
                        <span className="text-red-500 text-xs font-medium">✗ Failed</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">Pending</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(s.last_run_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleTogglePause(s)}
                        >
                          {s.paused ? "Resume" : "Pause"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(s.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ── CREATE VIEW ────────────────────────────────────────────
  if (view === "create") {
    return (
      <div className="max-w-lg mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>New Monitor</CardTitle>
          </CardHeader>
          <form onSubmit={handleCreate}>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="url">URL *</Label>
                <Input
                  id="url"
                  type="url"
                  placeholder="https://example.com"
                  value={formUrl}
                  onChange={e => setFormUrl(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cron">Cron expression *</Label>
                <Input
                  id="cron"
                  placeholder="0 * * * *"
                  value={formCron}
                  onChange={e => setFormCron(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  e.g. <code>0 * * * *</code> = every hour, <code>0 9 * * *</code> = daily at 9am
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="name">Name (optional)</Label>
                <Input
                  id="name"
                  placeholder="my-monitor"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                />
              </div>
              {formError && (
                <p className="text-red-500 text-sm">{formError}</p>
              )}
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setFormError(null); setView("list"); }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={formLoading}>
                {formLoading ? "Creating..." : "Create Monitor"}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  // ── DETAIL VIEW ────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <Button variant="outline" size="sm" onClick={() => setView("list")}>
        ← Back to list
      </Button>

      {selectedSchedule && (
        <Card>
          <CardHeader>
            <CardTitle>{selectedSchedule.name ?? selectedSchedule.url}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <span className="text-muted-foreground">URL</span>
              <span className="break-all">{selectedSchedule.url}</span>
              <span className="text-muted-foreground">Cron</span>
              <code>{selectedSchedule.cron}</code>
              <span className="text-muted-foreground">Status</span>
              <span>{selectedSchedule.paused ? "Paused" : selectedSchedule.last_run_status ?? "Pending"}</span>
              <span className="text-muted-foreground">Last run</span>
              <span>{formatDate(selectedSchedule.last_run_at)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Last Scrape Result</CardTitle>
        </CardHeader>
        <CardContent>
          {selectedSchedule?.last_result ? (
            <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap">
              {selectedSchedule.last_result.substring(0, 2000)}
              {selectedSchedule.last_result.length > 2000 && "\n\n[truncated...]"}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              No result yet — the schedule hasn't run or is still pending its first execution.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ask Claude</CardTitle>
        </CardHeader>
        <form onSubmit={handleAsk}>
          <CardContent className="space-y-3">
            <Input
              placeholder={
                selectedSchedule?.last_result
                  ? "Ask a question about the scraped content..."
                  : "Run the schedule first to enable Q&A"
              }
              value={question}
              onChange={e => setQuestion(e.target.value)}
              disabled={!selectedSchedule?.last_result || asking}
            />
            {askError && <p className="text-red-500 text-sm">{askError}</p>}
            {answer && (
              <div className="bg-muted rounded p-3 text-sm">
                <p className="font-medium text-xs text-muted-foreground mb-1">Answer</p>
                <p className="whitespace-pre-wrap">{answer}</p>
              </div>
            )}
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              disabled={!selectedSchedule?.last_result || !question.trim() || asking}
            >
              {asking ? "Asking..." : "Ask"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
