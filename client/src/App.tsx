import { useState } from "react";
import { FileUpload } from "@/components/dashboard/file-upload";
import { ProcessingView } from "@/components/dashboard/processing-view";
import { ResultsView } from "@/components/dashboard/results-view";
import { Globe, Languages, Sparkles, Settings } from "lucide-react";
import heroBg from "./assets/hero-bg.png";

function App() {
  const [appState, setAppState] = useState<"idle" | "processing" | "results">(
    "idle"
  );
  const [file, setFile] = useState<File | null>(null);

  const handleFileSelect = (selectedFile: File) => {
    setFile(selectedFile);
  };

  const startProcessing = () => {
    if (file) {
      setAppState("processing");
    }
  };

  const handleProcessingComplete = () => {
    setAppState("results");
  };

  const resetApp = () => {
    setAppState("idle");
    setFile(null);
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden font-sans text-foreground">
      {/* Background Decoration */}
      <div className="absolute inset-0 z-0 opacity-40 pointer-events-none">
        <img src={heroBg} alt="" className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-background/0 via-background/80 to-background" />
      </div>

      <div className="relative z-10 container mx-auto px-4 py-6 flex flex-col min-h-screen">
        {/* Header */}
        <header className="flex items-center justify-between mb-12 bg-card/50 backdrop-blur-md p-4 rounded-2xl border border-white/20 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/20">
              <Globe className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                LinguaMap
              </h1>
              <p className="text-xs text-muted-foreground">
                AI-Powered URL Alignment
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-muted/50">
              <Languages className="w-4 h-4" />
              <span>Target: EN, FR</span>
            </button>
            <button className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-muted/50">
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col items-center justify-center max-w-5xl mx-auto w-full">
          {appState === "idle" && (
            <div className="w-full max-w-2xl text-center space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
              <div className="space-y-4">
                <h2 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground">
                  Map Your Website's <br />
                  <span className="text-primary">Global Footprint</span>
                </h2>
                <p className="text-lg text-muted-foreground max-w-lg mx-auto leading-relaxed">
                  Upload your source URLs and let our engine automatically find
                  and align their international counterparts using intelligent
                  structure and metadata matching.
                </p>
              </div>

              <div className="space-y-6">
                <FileUpload onFileSelect={handleFileSelect} />

                {file && (
                  <button
                    onClick={startProcessing}
                    className="group inline-flex items-center gap-2 px-8 py-3 bg-primary text-primary-foreground rounded-full font-medium shadow-lg shadow-primary/25 hover:bg-primary/90 hover:scale-105 transition-all duration-300"
                  >
                    <Sparkles className="w-4 h-4 group-hover:animate-pulse" />
                    Start Mapping Process
                  </button>
                )}
              </div>
            </div>
          )}

          {appState === "processing" && (
            <div className="w-full animate-in fade-in zoom-in-95 duration-500">
              <ProcessingView onComplete={handleProcessingComplete} />
            </div>
          )}

          {appState === "results" && (
            <div className="w-full animate-in fade-in slide-in-from-bottom-8 duration-700">
              <ResultsView onReset={resetApp} />
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="mt-12 py-6 border-t border-border/50 text-center text-xs text-muted-foreground">
          <p>© 2024 LinguaMap Prototype. Built for Design Evaluation.</p>
        </footer>
      </div>
    </div>
  );
}

export default App;