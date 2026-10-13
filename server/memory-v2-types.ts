export type MemoryV2Type = "fact" | "observation" | "reflection" | "event";

export type MemoryV2Source = "manual" | "migration" | "extraction";

export type MemoryV2Category = "general" | "private";

export type MemoryV2Domain = "relationship" | "life" | "work" | "private_world" | "self" | "other";

export type MemoryV2Status = "active" | "superseded";

export type ReflectionObservationOrigin = "chat" | "nightly_review" | "legacy";
export type ReflectionClaimedStatus = "raw" | "claimed" | "unreviewed" | "uncertain" | "not_claimed" | "withdrawn" | "archived";
export type ReflectionRuntimeEligibility = "eligible" | "excluded";

export type ReflectionObservationMetaInput = {
  origin: ReflectionObservationOrigin;
  claimedStatus: ReflectionClaimedStatus;
  runtimeEligibility: ReflectionRuntimeEligibility;
  createdAt?: string;
  reviewNote?: string | null;
  reviewedAt?: string | null;
};

export type MemoryV2Item = {
  id: number;
  type: MemoryV2Type;
  category: MemoryV2Category;
  domain: MemoryV2Domain | null;
  tag: string | null;
  status: MemoryV2Status;
  superseded_by: number | null;
  superseded_at: string | null;
  content: string;
  source: MemoryV2Source;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type CreateMemoryV2Input = {
  type: MemoryV2Type;
  category?: MemoryV2Category;
  domain?: MemoryV2Domain | null;
  tag?: string | null;
  content: string;
  source?: MemoryV2Source;
};

export type UpdateMemoryV2Input = {
  id: number;
  type?: MemoryV2Type;
  category?: MemoryV2Category;
  domain?: MemoryV2Domain | null;
  tag?: string | null;
  status?: MemoryV2Status;
  superseded_by?: number | null;
  superseded_at?: string | null;
  content?: string;
  source?: MemoryV2Source;
};

export type SearchMemoryV2Input = {
  query: string;
  limit?: number;
  types?: MemoryV2Type[];
  categories?: MemoryV2Category[];
  domains?: MemoryV2Domain[];
  statuses?: MemoryV2Status[];
  includeSuperseded?: boolean;
  excludeNightReflections?: boolean;
};

export type SupersedeMemoryV2Input = {
  id: number;
  replacement: CreateMemoryV2Input;
  reflectionMeta?: ReflectionObservationMetaInput;
};
