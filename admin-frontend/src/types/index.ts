export interface User {
  id: string
  email: string
  role: 'admin' | 'user'
  group_id?: string
  must_change_password?: boolean
  created_at?: string
}

export interface Group {
  id: string
  name: string
  priority: number
  created_at?: string
}

export interface Benchmark {
  id: string
  user_id: string
  name: string
  original_filename: string
  file_size: number
  status: string
  compressors: Record<string, unknown>
  error?: string
  created_at: string
  started_at?: string
  finished_at?: string
}
