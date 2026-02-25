import { motion } from "framer-motion";
import { Download, RotateCcw, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { getJobResults, getJobConflicts, getDownloadUrl, type MappingResultRow, type ReferenceConflict } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ResultsViewProps {
  jobId: string;
  onReset: () => void;
}

export function ResultsView({ jobId, onReset }: ResultsViewProps) {
  const [results, setResults] = useState<MappingResultRow[]>([]);
  const [conflicts, setConflicts] = useState<ReferenceConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all");
  const [showConflicts, setShowConflicts] = useState(false);

  useEffect(() => {
    Promise.all([
      getJobResults(jobId),
      getJobConflicts(jobId),
    ])
      .then(([res, conf]) => {
        setResults(res);
        setConflicts(conf);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [jobId]);

  const filtered = results.filter((r) => {
    if (filter === "matched") return r.confidenceEn !== null || r.confidenceFr !== null;
    if (filter === "unmatched") return r.confidenceEn === null && r.confidenceFr === null && !r.englishUrl && !r.frenchUrl;
    return true;
  });

  const matchedCount = results.filter((r) => r.confidenceEn !== null || r.confidenceFr !== null).length;
  const prefilledCount = results.filter((r) => (r.englishUrl || r.frenchUrl) && r.confidenceEn === null && r.confidenceFr === null).length;

  if (loading) {
    return (
      <div className="text-center py-12 text-muted-foreground">Loading results...</div>
    );
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight" data-testid="text-results-title">Mapping Results</h2>
          <p className="text-muted-foreground text-sm">
            {results.length} URLs processed. {matchedCount} new matches found. {prefilledCount} already mapped.
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={onReset} data-testid="button-reset" className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors border border-border rounded-lg hover:bg-muted/50">
            <RotateCcw className="w-4 h-4" />
            Start Over
          </button>
          <a href={getDownloadUrl(jobId)} download data-testid="button-download" className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors shadow-sm text-sm font-medium">
            <Download className="w-4 h-4" />
            Download Excel
          </a>
        </div>
      </div>

      <div className="flex gap-2">
        {(["all", "matched", "unmatched"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            data-testid={`button-filter-${f}`}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-full border transition-colors capitalize",
              filter === f ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:bg-muted/50"
            )}
          >
            {f} {f === "all" ? `(${results.length})` : f === "matched" ? `(${matchedCount})` : `(${results.length - matchedCount - prefilledCount})`}
          </button>
        ))}
      </div>

      {conflicts.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 overflow-hidden shadow-sm"
          data-testid="panel-conflicts"
        >
          <button
            onClick={() => setShowConflicts(!showConflicts)}
            className="w-full flex items-center justify-between p-4 hover:bg-yellow-500/10 transition-colors"
            data-testid="button-toggle-conflicts"
          >
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              <div className="text-left">
                <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                  {conflicts.length} reference conflict{conflicts.length !== 1 ? "s" : ""} detected
                </p>
                <p className="text-xs text-muted-foreground">
                  These reference pairs were excluded from pattern learning because their directory mappings conflict with the majority.
                </p>
              </div>
            </div>
            {showConflicts ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
          {showConflicts && (
            <div className="border-t border-yellow-500/20 p-4 space-y-3 max-h-80 overflow-y-auto">
              {conflicts.map((c, i) => (
                <div key={i} className="text-xs space-y-1 pb-3 border-b border-yellow-500/10 last:border-0 last:pb-0" data-testid={`conflict-item-${i}`}>
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-yellow-500/20 text-yellow-700 dark:text-yellow-400">
                      {c.lang}
                    </span>
                    {c.sheetName && (
                      <span className="text-muted-foreground">Sheet: {c.sheetName}</span>
                    )}
                  </div>
                  <div className="font-mono text-foreground/80">
                    <span className="text-muted-foreground">Source:</span> {c.sourceUrl}
                  </div>
                  <div className="font-mono text-red-500/80">
                    <span className="text-muted-foreground">Wrong target:</span> {c.targetUrl}
                  </div>
                  <div className="text-muted-foreground italic">{c.reason}</div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left" data-testid="table-results">
            <thead className="bg-muted/50 text-muted-foreground font-medium border-b border-border">
              <tr>
                <th className="px-4 py-3 w-[60px]">#</th>
                <th className="px-4 py-3">Source URL</th>
                <th className="px-4 py-3">English URL</th>
                <th className="px-4 py-3">French URL</th>
                <th className="px-4 py-3 text-center w-[100px]">Confidence</th>
                <th className="px-4 py-3 text-right w-[80px]">Method</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.slice(0, 100).map((row, idx) => {
                const bestConfidence = Math.max(row.confidenceEn || 0, row.confidenceFr || 0);
                const method = row.matchMethodEn || row.matchMethodFr || "";

                return (
                  <motion.tr
                    key={row.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.5) }}
                    className="group hover:bg-muted/30 transition-colors"
                    data-testid={`row-result-${row.id}`}
                  >
                    <td className="px-4 py-3 text-muted-foreground text-xs">{row.rowIndex}</td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground/80 max-w-[220px] truncate" title={row.sourceUrl}>
                      {row.sourceUrl}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[220px] truncate" title={row.englishUrl || ""}>
                      {row.englishUrl || <span className="italic opacity-50">—</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[220px] truncate" title={row.frenchUrl || ""}>
                      {row.frenchUrl || <span className="italic opacity-50">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {bestConfidence > 0 ? (
                        <div className="flex items-center justify-center gap-2">
                          <div className={cn("w-2 h-2 rounded-full", bestConfidence > 85 ? "bg-green-500" : "bg-yellow-500")} />
                          <span className={cn("font-medium text-xs", bestConfidence > 85 ? "text-green-600" : "text-yellow-600")}>
                            {bestConfidence}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {method ? (
                        <span className="px-2 py-0.5 rounded text-[10px] bg-muted text-muted-foreground uppercase tracking-wider font-semibold border border-border">
                          {method}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">—</span>
                      )}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 100 && (
          <div className="p-4 text-center text-sm text-muted-foreground border-t border-border">
            Showing first 100 of {filtered.length} results. Download the Excel file for the full dataset.
          </div>
        )}
      </div>
    </div>
  );
}