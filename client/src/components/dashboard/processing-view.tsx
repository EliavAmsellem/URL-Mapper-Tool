import { motion } from "framer-motion";
import { Check, Loader2, Search, FileCode, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

interface ProcessingViewProps {
  onComplete: () => void;
}

export function ProcessingView({ onComplete }: ProcessingViewProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);

  const steps = [
    {
      id: "slug",
      title: "Slug Analysis",
      icon: Search,
      desc: "Comparing URL path structures...",
    },
    {
      id: "meta",
      title: "Metadata Extraction",
      icon: FileCode,
      desc: "Analyzing <title> and og:tags...",
    },
    {
      id: "structure",
      title: "Structure Matching",
      icon: GitMerge,
      desc: "Evaluating DOM depth and class signatures...",
    },
  ];

  // Simulation effect
  useEffect(() => {
    let interval: NodeJS.Timeout;
    let logInterval: NodeJS.Timeout;

    // Progress bar simulation
    interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(onComplete, 800); // Small delay before finishing
          return 100;
        }
        return prev + 1; // Increment progress
      });
    }, 50);

    // Step switching simulation
    if (progress < 30) setCurrentStep(0);
    else if (progress < 70) setCurrentStep(1);
    else setCurrentStep(2);

    return () => clearInterval(interval);
  }, [progress, onComplete]);

  // Log simulation
  useEffect(() => {
    const possibleLogs = [
      "Fetching source: example.com/products...",
      "Found EN candidate: new-site.com/en/shop...",
      "Analyzing slug similarity score...",
      "Extracting og:title tags...",
      "Comparing DOM depth...",
      "Rate limiting engaged (200ms delay)...",
      "Confidence score calculated: 98%",
    ];

    const logInterval = setInterval(() => {
      const randomLog =
        possibleLogs[Math.floor(Math.random() * possibleLogs.length)];
      setLogs((prev) => [randomLog, ...prev].slice(0, 5));
    }, 800);

    return () => clearInterval(logInterval);
  }, []);

  return (
    <div className="w-full max-w-2xl mx-auto bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="p-6 border-b border-border bg-muted/30">
        <h3 className="font-medium text-foreground mb-4">Processing Engine</h3>
        
        {/* Progress Bar */}
        <div className="h-2 w-full bg-muted rounded-full overflow-hidden mb-2">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: "0%" }}
            animate={{ width: `${progress}%` }}
            transition={{ ease: "linear" }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground font-mono">
          <span>{Math.round(progress)}% Complete</span>
          <span>{progress < 100 ? "Running..." : "Finalizing..."}</span>
        </div>
      </div>

      <div className="p-6 grid gap-6">
        {/* Steps Visualization */}
        <div className="grid grid-cols-3 gap-4">
          {steps.map((step, idx) => {
            const isActive = idx === currentStep;
            const isCompleted = idx < currentStep;
            const Icon = step.icon;

            return (
              <div
                key={step.id}
                className={cn(
                  "flex flex-col items-center text-center gap-2 p-3 rounded-lg transition-all duration-300 border",
                  isActive
                    ? "bg-primary/5 border-primary/20 text-primary"
                    : isCompleted
                    ? "bg-green-500/5 border-green-500/20 text-green-600"
                    : "bg-muted/10 border-transparent text-muted-foreground opacity-50"
                )}
              >
                <div
                  className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center mb-1",
                    isActive
                      ? "bg-primary/10"
                      : isCompleted
                      ? "bg-green-500/10"
                      : "bg-muted"
                  )}
                >
                  {isCompleted ? (
                    <Check className="w-4 h-4" />
                  ) : isActive ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                </div>
                <div className="text-xs font-medium">{step.title}</div>
              </div>
            );
          })}
        </div>

        {/* Live Terminal Log */}
        <div className="bg-black/90 text-green-400 font-mono text-xs p-4 rounded-lg h-32 overflow-hidden flex flex-col-reverse shadow-inner">
          {logs.map((log, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="mb-1"
            >
              <span className="opacity-50 mr-2">
                [{new Date().toLocaleTimeString()}]
              </span>
              {log}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}