import { motion } from "framer-motion";
import { Download, ExternalLink, AlertCircle, CheckCircle } from "lucide-react";
import { MappingResult, MOCK_RESULTS } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import Papa from "papaparse";

interface ResultsViewProps {
  onReset: () => void;
}

export function ResultsView({ onReset }: ResultsViewProps) {
  const handleDownload = () => {
    const csv = Papa.unparse(MOCK_RESULTS);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "mapped_urls_export.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Mapping Results</h2>
          <p className="text-muted-foreground">
            Processed {MOCK_RESULTS.length} URLs with an 85% confidence threshold.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onReset}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Start Over
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Download className="w-4 h-4" />
            Download Excel
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50 text-muted-foreground font-medium border-b border-border">
              <tr>
                <th className="px-4 py-3">Source URL</th>
                <th className="px-4 py-3">Target (EN)</th>
                <th className="px-4 py-3">Target (FR)</th>
                <th className="px-4 py-3 text-center">Confidence</th>
                <th className="px-4 py-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MOCK_RESULTS.map((row, idx) => (
                <motion.tr
                  key={row.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="group hover:bg-muted/30 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-xs text-foreground/80 max-w-[200px] truncate" title={row.sourceUrl}>
                    {row.sourceUrl}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[200px] truncate" title={row.targetUrlEn}>
                    {row.targetUrlEn || <span className="italic opacity-50">Not found</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[200px] truncate" title={row.targetUrlFr}>
                    {row.targetUrlFr || <span className="italic opacity-50">Not found</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <div className={cn(
                        "w-2 h-2 rounded-full",
                        row.confidence > 85 ? "bg-green-500" : "bg-yellow-500"
                      )} />
                      <span className={cn(
                        "font-medium",
                        row.confidence > 85 ? "text-green-600" : "text-yellow-600"
                      )}>
                        {row.confidence}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <span className="px-2 py-0.5 rounded text-[10px] bg-muted text-muted-foreground uppercase tracking-wider font-semibold border border-border">
                        {row.method}
                      </span>
                    </div>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}