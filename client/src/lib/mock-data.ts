import { LucideIcon } from "lucide-react";

export type MappingResult = {
  id: string;
  sourceUrl: string;
  targetUrlEn: string;
  targetUrlFr: string;
  confidence: number;
  status: "matched" | "low_confidence" | "pending";
  method: "slug" | "meta" | "structure" | "mixed";
  details: {
    slugScore: number;
    titleScore: number;
    structureScore: number;
  };
};

export const MOCK_RESULTS: MappingResult[] = [
  {
    id: "1",
    sourceUrl: "https://example.com/products/solar-panel-x200",
    targetUrlEn: "https://new-site.com/en/shop/energy/solar-panel-x200",
    targetUrlFr: "https://new-site.com/fr/boutique/energie/panneau-solaire-x200",
    confidence: 98,
    status: "matched",
    method: "slug",
    details: { slugScore: 100, titleScore: 95, structureScore: 90 }
  },
  {
    id: "2",
    sourceUrl: "https://example.com/about-us/history",
    targetUrlEn: "https://new-site.com/en/company/our-story",
    targetUrlFr: "https://new-site.com/fr/entreprise/notre-histoire",
    confidence: 92,
    status: "matched",
    method: "meta",
    details: { slugScore: 40, titleScore: 98, structureScore: 85 }
  },
  {
    id: "3",
    sourceUrl: "https://example.com/blog/2023/sustainable-living-tips",
    targetUrlEn: "https://new-site.com/en/insights/sustainability/living-tips",
    targetUrlFr: "https://new-site.com/fr/idees/durabilite/conseils-vie",
    confidence: 89,
    status: "matched",
    method: "mixed",
    details: { slugScore: 70, titleScore: 85, structureScore: 95 }
  },
  {
    id: "4",
    sourceUrl: "https://example.com/legacy-page-123",
    targetUrlEn: "",
    targetUrlFr: "",
    confidence: 12,
    status: "low_confidence",
    method: "structure",
    details: { slugScore: 0, titleScore: 10, structureScore: 20 }
  },
  {
    id: "5",
    sourceUrl: "https://example.com/contact",
    targetUrlEn: "https://new-site.com/en/contact-us",
    targetUrlFr: "https://new-site.com/fr/contactez-nous",
    confidence: 99,
    status: "matched",
    method: "slug",
    details: { slugScore: 95, titleScore: 99, structureScore: 100 }
  },
  {
    id: "6",
    sourceUrl: "https://example.com/services/consulting",
    targetUrlEn: "https://new-site.com/en/services/advisory",
    targetUrlFr: "https://new-site.com/fr/services/conseil",
    confidence: 86,
    status: "matched",
    method: "structure",
    details: { slugScore: 60, titleScore: 80, structureScore: 95 }
  }
];

export const PROCESSING_STEPS = [
  { id: 1, name: "URL Slug Analysis", weight: "30%" },
  { id: 2, name: "Metadata Extraction (Title/OG)", weight: "50%" },
  { id: 3, name: "DOM Structure Matching", weight: "20%" },
];