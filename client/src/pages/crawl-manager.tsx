import { useState, useEffect, useCallback } from "react";
import {
  getCrawlSessions,
  getCrawlSession,
  startCrawl,
  refreshCrawl,
  deleteCrawlSession,
  type CrawlSession,
} from "@/lib/api";
import {
  Globe,
  Plus,
  RefreshCw,
  Trash2,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Database,
} from "lucide-react";

export function CrawlManager({ onBack }: { onBack: () => void }) {
  const [sessions, setSessions] = useState<CrawlSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formOrigin, setFormOrigin] = useState("https://www.btl.gov.il");
  const [formRootPath, setFormRootPath] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formMaxPages, setFormMaxPages] = useState(2000);
  const [formMaxDepth, setFormMaxDepth] = useState(6);
  const [submitting, setSubmitting] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const data = await getCrawlSessions();
      setSessions(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const hasCrawling = sessions.some((s) => s.status === "crawling" || s.status === "pending");
    if (!hasCrawling) return;
    const interval = setInterval(async () => {
      const data = await getCrawlSessions();
      setSessions(data);
    }, 3000);
    return () => clearInterval(interval);
  }, [sessions]);

  const handleStartCrawl = async () => {
    if (!formOrigin || !formRootPath) return;
    setSubmitting(true);
    setError(null);
    try {
      await startCrawl({
        origin: formOrigin,
        rootPath: formRootPath,
        label: formLabel || undefined,
        maxPages: formMaxPages,
        maxDepth: formMaxDepth,
      });
      setShowForm(false);
      setFormRootPath("");
      setFormLabel("");
      await loadSessions();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefresh = async (id: string) => {
    setError(null);
    try {
      await refreshCrawl(id);
      await loadSessions();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await deleteCrawlSession(id);
      await loadSessions();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "crawling":
        return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
      case "pending":
        return <Clock className="w-4 h-4 text-yellow-500" />;
      case "failed":
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-lg hover:bg-muted/50 transition-colors"
            data-testid="button-back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            <h2 className="text-2xl font-bold" data-testid="text-crawl-title">
              Crawl Inventory Manager
            </h2>
          </div>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
          data-testid="button-new-crawl"
        >
          <Plus className="w-4 h-4" />
          New Crawl
        </button>
      </div>

      {error && (
        <div className="text-destructive text-sm bg-destructive/10 p-3 rounded-lg" data-testid="text-crawl-error">
          {error}
        </div>
      )}

      {showForm && (
        <div className="bg-card border border-border rounded-xl p-6 space-y-4" data-testid="form-new-crawl">
          <h3 className="text-lg font-semibold">Start New Crawl</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Origin URL</label>
              <input
                type="text"
                value={formOrigin}
                onChange={(e) => setFormOrigin(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder="https://www.btl.gov.il"
                data-testid="input-origin"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Root Path</label>
              <input
                type="text"
                value={formRootPath}
                onChange={(e) => setFormRootPath(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder="/English%20Homepage/Benefits"
                data-testid="input-root-path"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Label (optional)</label>
              <input
                type="text"
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder="EN Benefits"
                data-testid="input-label"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Max Pages</label>
                <input
                  type="number"
                  value={formMaxPages}
                  onChange={(e) => setFormMaxPages(parseInt(e.target.value) || 2000)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  data-testid="input-max-pages"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Max Depth</label>
                <input
                  type="number"
                  value={formMaxDepth}
                  onChange={(e) => setFormMaxDepth(parseInt(e.target.value) || 6)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  data-testid="input-max-depth"
                />
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleStartCrawl}
              disabled={submitting || !formOrigin || !formRootPath}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              data-testid="button-submit-crawl"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
              Start Crawl
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted/50 transition-colors"
              data-testid="button-cancel-crawl"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground" data-testid="text-no-sessions">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No crawl sessions yet. Start a new crawl to build your inventory.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="bg-card border border-border rounded-xl p-4 flex items-center justify-between hover:border-primary/30 transition-colors"
              data-testid={`card-session-${session.id}`}
            >
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <div className="flex-shrink-0">{statusIcon(session.status)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate" data-testid={`text-session-label-${session.id}`}>
                      {session.label || session.rootPath}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {session.status}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {session.origin}
                    <span className="font-mono">{session.rootPath}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                    <span data-testid={`text-session-urls-${session.id}`}>
                      {session.totalUrls} URLs
                    </span>
                    <span>Max: {session.maxPages} pages, depth {session.maxDepth}</span>
                    {session.completedAt && <span>Completed: {formatDate(session.completedAt)}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 ml-4">
                <button
                  onClick={() => handleRefresh(session.id)}
                  disabled={session.status === "crawling"}
                  className="p-2 rounded-lg hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
                  title="Re-crawl"
                  data-testid={`button-refresh-${session.id}`}
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(session.id)}
                  disabled={session.status === "crawling"}
                  className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30"
                  title="Delete"
                  data-testid={`button-delete-${session.id}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
