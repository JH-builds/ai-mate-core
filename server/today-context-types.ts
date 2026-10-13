export type TodayContext = {
  id: number;
  scope_id: string;
  date: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

export type TodayContextStateEntry = {
  key: string;
  value: string;
  updated_at: string;
};

export type UpsertTodayContextInput = {
  scope_id: string;
  date: string;
  summary: string;
  now?: Date;
};
