import { motion } from "framer-motion";
import { Check, Loader2, Search, GitMerge, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState, useRef } from "react";
import { getJobStatus, type JobStatus } from "@/lib/api";

interface ProcessingViewProps {
  jobId: string;
  onComplete: () => void;
}

function parseStep(currentStep: string): { phase: string; tabName: string | null; passNum: number | null } {
  if (currentStep.startsWith("pass")) {
    const parts = currentStep.split(":");
    const passNum = parseInt(parts[0].replace("pass", ""), 10);
    const tabName = parts.length > 1 ? parts.slice(1).join(":") : null;
    return { phase: "matching", tabName, passNum };
  }
  if (currentStep.startsWith("matching")) {
    const parts = currentStep.split(":");
    const tabName = parts.length > 1 ? parts.slice(1).join(":") : null;
    return { phase: "matching", tabName, passNum: 1 };
  }
  if (currentStep === "saving") {
    return { phase: "saving", tabName: null, passNum: null };
  }
  return { phase: currentStep, tabName: null, passNum: null };
}

export function ProcessingView({ jobId, onComplete }: ProcessingViewProps) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const prevStepRef = useRef<string>("");
  const prevMatchedRef = useRef<number>(0);

  const steps = [
    { id: "learning", title: "Learning Patterns", icon: Search, desc: "Extracting URL patterns from reference rows..." },
    { id: "matching", title: "URL Matching", icon: GitMerge, desc: "Constructing & verifying target URLs..." },
    { id: "saving", title: "Saving Results", icon: Save, desc: "Writing results to database..." },
  ];

  useEffect(() => {
    const poll = async () => {
      try {
        const status = await getJobStatus(jobId);
        setJob(status);

        const { phase, tabName, passNum } = parseStep(status.currentStep);
        const stepKey = status.currentStep;

        if (stepKey !== prevStepRef.current) {
          prevStepRef.current = stepKey;

          if (phase === "matching" && tabName) {
            const passLabel = passNum && passNum > 1 ? ` (Pass ${passNum})` : "";
            setLogs(prev => [`Processing tab: "${tabName}"${passLabel}`, ...prev].slice(0, 10));
          } else if (phase === "saving") {
            setLogs(prev => ["Saving results to database...", ...prev].slice(0, 10));
          }
        }

        if (status.matchedUrls > prevMatchedRef.current) {
          const diff = status.matchedUrls - prevMatchedRef.current;
          prevMatchedRef.current = status.matchedUrls;
          setLogs(prev => [`Found ${diff} new matches (${status.matchedUrls} total)`, ...prev].slice(0, 10));
        }

        if (status.status === "completed" || status.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          if (status.status === "completed") {
            setLogs(prev => [`Completed! ${status.matchedUrls} matches found across ${status.totalUrls} URLs`, ...prev].slice(0, 10));
          }
          setTimeout(onComplete, 1000);
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

  const currentPhase = job ? parseStep(job.currentStep).phase : "learning";
  const stepOrder = ["learning", "matching", "saving", "done"];
  const currentStepIndex = stepOrder.indexOf(currentPhase);

  const currentTabName = job ? parseStep(job.currentStep).tabName : null;
  const currentPass = job ? parseStep(job.currentStep).passNum : null;

  return (
    <div className="w-full max-w-2xl mx-auto bg-card border border-border rounded-xl overflow-hidden shadow-sm" data-testid="processing-view">
      <div className="p-6 border-b border-border bg-muted/30">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-foreground">Processing Engine</h3>
          {job && (
            <span className="text-xs font-mono text-muted-foreground" data-testid="text-url-count">
              {job.processedUrls}/{job.totalUrls} URLs
            </span>
          )}
        </div>

        <div className="h-2 w-full bg-muted rounded-full overflow-hidden mb-2">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: "0%" }}
            animate={{ width: `${Math.max(progress, currentPhase === "matching" && progress === 0 ? 2 : 0)}%` }}
            transition={{ ease: "easeOut", duration: 0.5 }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground font-mono">
          <span data-testid="text-progress">{progress}% Complete</span>
          <span data-testid="text-status">
            {job?.status === "completed" ? "Done!" : job?.status === "error" ? "Error" : currentTabName ? `Working on: ${currentTabName}` : "Running..."}
          </span>
        </div>
      </div>

      <div className="p-6 grid gap-6">
        <div className="grid grid-cols-3 gap-3">
          {steps.map((step, idx) => {
            const isActive = step.id === currentPhase;
            const isCompleted = currentStepIndex > idx || job?.status === "completed";
            const Icon = step.icon;

            return (
              <div
                key={step.id}
                data-testid={`step-${step.id}`}
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
                {isActive && currentPass && currentPass > 1 && step.id === "matching" && (
                  <div className="text-[10px] opacity-70">Pass {currentPass}</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="bg-black/90 text-green-400 font-mono text-xs p-4 rounded-lg h-36 overflow-hidden flex flex-col-reverse shadow-inner" data-testid="log-panel">
          {logs.map((log, i) => (
            <motion.div key={`${i}-${log}`} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="mb-1">
              <span className="opacity-50 mr-2">[{new Date().toLocaleTimeString()}]</span>
              {log}
            </motion.div>
          ))}
          {logs.length === 0 && (
            <div className="opacity-50 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              Initializing processing engine...
            </div>
          )}
        </div>

        {job && (
          <div className="flex justify-between text-sm text-muted-foreground">
            <span data-testid="text-matches">Matches found: <strong className="text-foreground">{job.matchedUrls}</strong></span>
            <span>File: <strong className="text-foreground">{job.fileName}</strong></span>
          </div>
        )}
      </div>
    </div>
  );
}
