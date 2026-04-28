import { motion } from "framer-motion";
import { Download, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getJobResults,
  getJobStatus,
  getDownloadUrl,
  LANG_META,
  type MappingResultRow,
  type JobStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface ResultsViewProps {
  jobId: string;
  onReset: () => void;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function ResultsView({ jobId, onReset }: ResultsViewProps) {
  const [results, setResults] = useState<MappingResultRow[]>([]);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all");

  useEffect(() => {
    let cancelled = false;
    getJobResults(jobId)
      .then((rows) => { if (!cancelled) setResults(rows); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    getJobStatus(jobId)
      .then((status) => { if (!cancelled) setJob(status); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [jobId]);

  const langsFromRows = (() => {
    const seen = new Set<string>();
    for (const r of results) {
      for (const l of Object.keys(LANG_META)) {
        if (str(r[LANG_META[l].urlKey]) || num(r[LANG_META[l].confKey]) !== null) {
          seen.add(l);
        }
      }
    }
    return Array.from(seen);
  })();

  const activeLangs = (
    job?.targetLanguages?.length
      ? job.targetLanguages
      : langsFromRows.length
        ? langsFromRows
        : ["en", "fr"]
  ).filter((l) => LANG_META[l]);

  const rowHasMatch = (r: MappingResultRow) =>
    activeLangs.some((l) => num(r[LANG_META[l].confKey]) !== null);

  const rowHasUrl = (r: MappingResultRow) =>
    activeLangs.some((l) => str(r[LANG_META[l].urlKey]) !== null);

  const filtered = results.filter((r) => {
    if (filter === "matched") return rowHasMatch(r);
    if (filter === "unmatched") return !rowHasMatch(r) && !rowHasUrl(r);
    return true;
  });

  const matchedCount = results.filter(rowHasMatch).length;
  const prefilledCount = results.filter((r) => rowHasUrl(r) && !rowHasMatch(r)).length;
  const unmatchedCount = results.length - matchedCount - prefilledCount;

  if (loading) {
    return <div className="text-center py-12 text-muted-foreground">Loading results...</div>;
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight" data-testid="text-results-title">Mapping Results</h2>
          <p className="text-muted-foreground text-sm" data-testid="text-results-summary">
            {results.length} URLs processed. {matchedCount} new matches found. {prefilledCount} already mapped.
            {activeLangs.length > 0 && (
              <> Target: <span className="font-medium text-foreground">{activeLangs.map((l) => l.toUpperCase()).join(", ")}</span>.</>
            )}
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
            {f} {f === "all" ? `(${results.length})` : f === "matched" ? `(${matchedCount})` : `(${unmatchedCount})`}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left" data-testid="table-results">
            <thead className="bg-muted/50 text-muted-foreground font-medium border-b border-border">
              <tr>
                <th className="px-4 py-3 w-[60px]">#</th>
                <th className="px-4 py-3">Source URL</th>
                {activeLangs.map((l) => (
                  <th key={l} className="px-4 py-3" data-testid={`th-${l}`}>
                    {LANG_META[l].label}
                  </th>
                ))}
                <th className="px-4 py-3 text-center w-[100px]">Confidence</th>
                <th className="px-4 py-3 text-right w-[100px]">Method</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.slice(0, 100).map((row, idx) => {
                const confs = activeLangs.map((l) => num(row[LANG_META[l].confKey]) || 0);
                const bestConfidence = confs.length ? Math.max(...confs) : 0;
                const method =
                  activeLangs
                    .map((l) => str(row[LANG_META[l].methodKey]))
                    .find((m) => m && m.length > 0) || "";

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
                    {activeLangs.map((l) => {
                      const url = str(row[LANG_META[l].urlKey]);
                      return (
                        <td
                          key={l}
                          className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[220px] truncate"
                          title={url || ""}
                          data-testid={`cell-${l}-${row.id}`}
                        >
                          {url || <span className="italic opacity-50">—</span>}
                        </td>
                      );
                    })}
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
