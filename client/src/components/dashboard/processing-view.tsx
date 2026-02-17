import { motion } from "framer-motion";
import { Check, Loader2, Search, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState, useRef } from "react";
import { getJobStatus, type JobStatus } from "@/lib/api";

interface ProcessingViewProps {
  jobId: string;
  onComplete: () => void;
}

export function ProcessingView({ jobId, onComplete }: ProcessingViewProps) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const steps = [
    { id: "learning", title: "Learning Patterns", icon: Search, desc: "Extracting URL patterns from reference rows..." },
    { id: "matching", title: "URL Matching", icon: GitMerge, desc: "Constructing & verifying target URLs..." },
  ];

  useEffect(() => {
    const poll = async () => {
      try {
        const status = await getJobStatus(jobId);
        setJob(status);

        if (status.processedUrls > 0) {
          setLogs(prev => {
            const newLog = `Processed ${status.processedUrls}/${status.totalUrls} URLs (${status.matchedUrls} matches found)`;
            return [newLog, ...prev].slice(0, 8);
          });
        }

        if (status.status === "completed" || status.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          setTimeout(onComplete, 500);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    };

    poll();
    pollRef.current = setInterval(poll, 2000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId, onComplete]);

  const progress = job ? (job.totalUrls > 0 ? Math.round((job.processedUrls / job.totalUrls) * 100) : 0) : 0;

  const currentStepId = job?.currentStep || "learning";
  const stepOrder = ["learning", "matching", "done"];
  const currentStepIndex = stepOrder.indexOf(currentStepId);

  return (
    <div className="w-full max-w-2xl mx-auto bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="p-6 border-b border-border bg-muted/30">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-foreground">Processing Engine</h3>
          {job && (
            <span className="text-xs font-mono text-muted-foreground">
              {job.processedUrls}/{job.totalUrls} URLs
            </span>
          )}
        </div>

        <div className="h-2 w-full bg-muted rounded-full overflow-hidden mb-2">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: "0%" }}
            animate={{ width: `${progress}%` }}
            transition={{ ease: "easeOut", duration: 0.5 }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground font-mono">
          <span>{progress}% Complete</span>
          <span>{job?.status === "completed" ? "Done!" : job?.status === "error" ? "Error" : "Running..."}</span>
        </div>
      </div>

      <div className="p-6 grid gap-6">
        <div className="grid grid-cols-2 gap-3">
          {steps.map((step, idx) => {
            const isActive = step.id === currentStepId;
            const isCompleted = currentStepIndex > idx || job?.status === "completed";
            const Icon = step.icon;

            return (
              <div
                key={step.id}
                className={cn(
                  "flex flex-col items-center text-center gap-2 p-3 rounded-lg transition-all duration-300 border",
                  isActive ? "bg-primary/5 border-primary/20 text-primary"
                    : isCompleted ? "bg-green-500/5 border-green-500/20 text-green-600"
                    : "bg-muted/10 border-transparent text-muted-foreground opacity-50"
                )}
              >
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center mb-1",
                  isActive ? "bg-primary/10" : isCompleted ? "bg-green-500/10" : "bg-muted"
                )}>
                  {isCompleted ? <Check className="w-4 h-4" /> : isActive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
                </div>
                <div className="text-xs font-medium">{step.title}</div>
              </div>
            );
          })}
        </div>

        <div className="bg-black/90 text-green-400 font-mono text-xs p-4 rounded-lg h-36 overflow-hidden flex flex-col-reverse shadow-inner">
          {logs.map((log, i) => (
            <motion.div key={`${i}-${log}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="mb-1">
              <span className="opacity-50 mr-2">[{new Date().toLocaleTimeString()}]</span>
              {log}
            </motion.div>
          ))}
          {logs.length === 0 && (
            <div className="opacity-50">Initializing scraping engine...</div>
          )}
        </div>

        {job && (
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>Matches found: <strong className="text-foreground">{job.matchedUrls}</strong></span>
            <span>File: <strong className="text-foreground">{job.fileName}</strong></span>
          </div>
        )}
      </div>
    </div>
  );
}