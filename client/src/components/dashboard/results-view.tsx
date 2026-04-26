import { motion } from "framer-motion";
import { Download, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { getJobResults, getJobStatus, getDownloadUrl, type MappingResultRow } from "@/lib/api";
import { cn } from "@/lib/utils";

const LANG_CONFIG = {
  en: { label: "English URL", urlKey: "englishUrl" as const, confKey: "confidenceEn" as const, methodKey: "matchMethodEn" as const },
  fr: { label: "French URL", urlKey: "frenchUrl" as const, confKey: "confidenceFr" as const, methodKey: "matchMethodFr" as const },
  ru: { label: "Russian URL", urlKey: "russianUrl" as const, confKey: "confidenceRu" as const, methodKey: "matchMethodRu" as const },
  ar: { label: "Arabic URL", urlKey: "arabicUrl" as const, confKey: "confidenceAr" as const, methodKey: "matchMethodAr" as const },
} as const;

type LangCode = keyof typeof LANG_CONFIG;

function hasMatch(row: MappingResultRow, langs: LangCode[]): boolean {
  return langs.some(l => {
    const cfg = LANG_CONFIG[l];
    return row[cfg.confKey] !== null;
  });
}

function isPrefilled(row: MappingResultRow, langs: LangCode[]): boolean {
  const hasUrl = langs.some(l => !!row[LANG_CONFIG[l].urlKey]);
  const hasNewMatch = hasMatch(row, langs);
  return hasUrl && !hasNewMatch;
}

interface ResultsViewProps {
  jobId: string;
  onReset: () => void;
}

export function ResultsView({ jobId, onReset }: ResultsViewProps) {
  const [results, setResults] = useState<MappingResultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all");
  const [targetLangs, setTargetLangs] = useState<LangCode[]>(["en", "fr", "ru", "ar"]);

  useEffect(() => {
    Promise.all([
      getJobResults(jobId),
      getJobStatus(jobId),
    ])
      .then(([resultsData, status]) => {
        setResults(resultsData);
        const langs = (status.targetLanguages || []).filter((l): l is LangCode => l in LANG_CONFIG);
        if (langs.length > 0) setTargetLangs(langs);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [jobId]);

  const filtered = results.filter((r) => {
    if (filter === "matched") return hasMatch(r, targetLangs);
    if (filter === "unmatched") return !hasMatch(r, targetLangs) && !isPrefilled(r, targetLangs);
    return true;
  });

  const matchedCount = results.filter((r) => hasMatch(r, targetLangs)).length;
  const prefilledCount = results.filter((r) => isPrefilled(r, targetLangs)).length;

  const activeLangs = targetLangs.map(l => LANG_CONFIG[l]);

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

      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left" data-testid="table-results">
            <thead className="bg-muted/50 text-muted-foreground font-medium border-b border-border">
              <tr>
                <th className="px-4 py-3 w-[60px]">#</th>
                <th className="px-4 py-3">Source URL</th>
                {activeLangs.map(cfg => (
                  <th key={cfg.label} className="px-4 py-3">{cfg.label}</th>
                ))}
                <th className="px-4 py-3 text-center w-[100px]">Confidence</th>
                <th className="px-4 py-3 text-right w-[80px]">Method</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.slice(0, 100).map((row, idx) => {
                const confValues = targetLangs
                  .map(l => LANG_CONFIG[l].confKey ? (row[LANG_CONFIG[l].confKey!] || 0) : 0)
                  .filter(v => v > 0);
                const bestConfidence = confValues.length > 0 ? Math.max(...confValues) : 0;

                const methods = targetLangs
                  .map(l => LANG_CONFIG[l].methodKey ? (row[LANG_CONFIG[l].methodKey!] || "") : "")
                  .filter(Boolean);
                const method = methods[0] || "";

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
                    {activeLangs.map(cfg => {
                      const url = row[cfg.urlKey];
                      return (
                        <td key={cfg.label} className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[220px] truncate" title={url || ""}>
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
