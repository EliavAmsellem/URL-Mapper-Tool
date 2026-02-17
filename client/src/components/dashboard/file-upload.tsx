import React, { useState, useCallback } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  isProcessing?: boolean;
}

export function FileUpload({ onFileSelect, isProcessing }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (
          file.type.includes("sheet") ||
          file.type.includes("excel") ||
          file.name.endsWith(".xlsx") ||
          file.name.endsWith(".csv")
        ) {
          setSelectedFile(file);
          onFileSelect(file);
        } else {
          alert("Please upload an Excel or CSV file.");
        }
      }
    },
    [onFileSelect]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        const file = e.target.files[0];
        setSelectedFile(file);
        onFileSelect(file);
      }
    },
    [onFileSelect]
  );

  const clearFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedFile(null);
  };

  return (
    <div className="w-full max-w-xl mx-auto">
      <AnimatePresence mode="wait">
        {!selectedFile ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={cn(
              "relative group cursor-pointer border-2 border-dashed rounded-xl p-12 transition-all duration-300 ease-out",
              isDragging
                ? "border-primary bg-primary/5 scale-[1.02]"
                : "border-border hover:border-primary/50 hover:bg-muted/30"
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => document.getElementById("file-upload")?.click()}
          >
            <input
              id="file-upload"
              type="file"
              className="hidden"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileInput}
            />
            <div className="flex flex-col items-center justify-center text-center gap-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary group-hover:scale-110 transition-transform duration-300">
                <Upload className="w-8 h-8" />
              </div>
              <div>
                <h3 className="text-lg font-medium text-foreground">
                  Upload Source URLs
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Drag & drop your Excel file here, or click to browse
                </p>
              </div>
              <div className="flex gap-2 text-xs text-muted-foreground/70 bg-muted/50 px-3 py-1 rounded-full">
                <span>.XLSX</span>
                <span>.CSV</span>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-card border border-border rounded-xl p-6 shadow-sm flex items-center justify-between"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-green-100 text-green-600 flex items-center justify-center">
                <FileSpreadsheet className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-medium text-foreground truncate max-w-[200px]">
                  {selectedFile.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {(selectedFile.size / 1024).toFixed(1)} KB
                </p>
              </div>
            </div>
            {!isProcessing && (
              <button
                onClick={clearFile}
                className="p-2 hover:bg-destructive/10 hover:text-destructive rounded-full transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            )}
            {isProcessing && (
              <div className="flex items-center gap-2 text-primary text-sm font-medium animate-pulse">
                <div className="w-2 h-2 rounded-full bg-primary" />
                Processing...
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}