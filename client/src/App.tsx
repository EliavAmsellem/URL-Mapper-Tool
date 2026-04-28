import { useState, useCallback } from "react";
import { FileUpload } from "@/components/dashboard/file-upload";
import { ProcessingView } from "@/components/dashboard/processing-view";
import { ResultsView } from "@/components/dashboard/results-view";
import { Globe, Languages, Sparkles } from "lucide-react";
import { uploadFile, startJob, LANG_OPTIONS, type LangCode } from "@/lib/api";
import { cn } from "@/lib/utils";
import heroBg from "./assets/hero-bg.png";

function App() {
  const [appState, setAppState] = useState<"idle" | "uploading" | "processing" | "results">("idle");
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLangs, setSelectedLangs] = useState<LangCode[]>(["en"]);

  const handleFileSelect = (selectedFile: File) => {
    setFile(selectedFile);
    setError(null);
  };

  const toggleLang = (code: LangCode) => {
    setSelectedLangs((prev) => {
      if (prev.includes(code)) {
        if (prev.length === 1) return prev;
        return prev.filter((c) => c !== code);
      }
      const ordered = LANG_OPTIONS.map((o) => o.code).filter(
        (c) => prev.includes(c) || c === code
      );
      return ordered;
    });
  };

  const handleStartProcessing = async () => {
    if (!file) return;
    if (selectedLangs.length === 0) {
      setError("Pick at least one target language.");
      return;
    }
    setError(null);
    setAppState("uploading");

    try {
      const result = await uploadFile(file, selectedLangs);
      setJobId(result.jobId);
      await startJob(result.jobId, 85);
      setAppState("processing");
    } catch (err: any) {
      setError(err.message || "Something went wrong");
      setAppState("idle");
    }
  };

  const handleProcessingComplete = useCallback(() => {
    setAppState("results");
  }, []);

  const resetApp = () => {
    setAppState("idle");
    setFile(null);
    setJobId(null);
    setError(null);
  };

  const targetLabel = selectedLangs.map((c) => c.toUpperCase()).join(", ") || "—";

  return (
    <div className="min-h-screen bg-background relative overflow-hidden font-sans text-foreground">
      <div className="absolute inset-0 z-0 opacity-40 pointer-events-none">
        <img src={heroBg} alt="" className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-background/0 via-background/80 to-background" />
      </div>

      <div className="relative z-10 container mx-auto px-4 py-6 flex flex-col min-h-screen">
        <header className="flex items-center justify-between mb-12 bg-card/50 backdrop-blur-md p-4 rounded-2xl border border-white/20 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/20" data-testid="img-logo">
              <Globe className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">LinguaMap</h1>
              <p className="text-xs text-muted-foreground">AI-Powered URL Alignment</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground px-3 py-1.5 rounded-lg bg-muted/30"
              data-testid="text-target-languages"
            >
              <Languages className="w-4 h-4" />
              <span>Target: {targetLabel}</span>
            </div>
          </div>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center max-w-5xl mx-auto w-full">
          {(appState === "idle" || appState === "uploading") && (
            <div className="w-full max-w-2xl text-center space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
              <div className="space-y-4">
                <h2 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground">
                  Map Your Website's <br />
                  <span className="text-primary">Global Footprint</span>
                </h2>
                <p className="text-lg text-muted-foreground max-w-lg mx-auto leading-relaxed">
                  Upload your source URLs and let our engine automatically find and align their international counterparts using intelligent structure and metadata matching.
                </p>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <p className="text-sm font-medium text-muted-foreground">Target language(s)</p>
                  <div className="flex justify-center gap-2 flex-wrap" data-testid="lang-picker">
                    {LANG_OPTIONS.map((opt) => {
                      const active = selectedLangs.includes(opt.code);
                      const onlyOne = active && selectedLangs.length === 1;
                      return (
                        <button
                          key={opt.code}
                          type="button"
                          onClick={() => toggleLang(opt.code)}
                          disabled={appState === "uploading" || onlyOne}
                          data-testid={`button-lang-${opt.code}`}
                          aria-pressed={active}
                          title={onlyOne ? `${opt.name} — at least one language must stay selected` : opt.name}
                          className={cn(
                            "px-4 py-2 text-sm font-semibold rounded-full border transition-colors",
                            active
                              ? "bg-primary text-primary-foreground border-primary shadow-sm"
                              : "bg-card text-muted-foreground border-border hover:bg-muted/50",
                            (appState === "uploading" || onlyOne) && "cursor-not-allowed opacity-90"
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <FileUpload onFileSelect={handleFileSelect} isProcessing={appState === "uploading"} />

                {error && (
                  <div className="text-destructive text-sm bg-destructive/10 p-3 rounded-lg" data-testid="text-error">
                    {error}
                  </div>
                )}

                {file && appState === "idle" && (
                  <button
                    onClick={handleStartProcessing}
                    data-testid="button-start"
                    className="group inline-flex items-center gap-2 px-8 py-3 bg-primary text-primary-foreground rounded-full font-medium shadow-lg shadow-primary/25 hover:bg-primary/90 hover:scale-105 transition-all duration-300"
                  >
                    <Sparkles className="w-4 h-4 group-hover:animate-pulse" />
                    Start Mapping Process
                  </button>
                )}

                {appState === "uploading" && (
                  <div className="flex items-center justify-center gap-2 text-primary text-sm font-medium animate-pulse">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                    Uploading file...
                  </div>
                )}
              </div>
            </div>
          )}

          {appState === "processing" && jobId && (
            <div className="w-full animate-in fade-in zoom-in-95 duration-500">
              <ProcessingView jobId={jobId} onComplete={handleProcessingComplete} />
            </div>
          )}

          {appState === "results" && jobId && (
            <div className="w-full animate-in fade-in slide-in-from-bottom-8 duration-700">
              <ResultsView jobId={jobId} onReset={resetApp} />
            </div>
          )}
        </main>

        <footer className="mt-12 py-6 border-t border-border/50 text-center text-xs text-muted-foreground">
          <p>LinguaMap — Multilingual Website URL Mapper</p>
        </footer>
      </div>
    </div>
  );
}

export default App;
