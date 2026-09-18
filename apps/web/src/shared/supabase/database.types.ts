export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      airfare_documents: {
        Row: {
          key: string;
          replicated_at: string;
          source_updated_at: string;
          value: Json;
        };
        Insert: {
          key: string;
          replicated_at?: string;
          source_updated_at: string;
          value: Json;
        };
        Update: {
          key?: string;
          replicated_at?: string;
          source_updated_at?: string;
          value?: Json;
        };
        Relationships: [];
      };
      airfare_import_runs: {
        Row: {
          completed_at: string | null;
          destination_manifest: Json;
          error: string | null;
          mode: string;
          run_id: string;
          source_manifest: Json;
          started_at: string;
          status: string;
        };
        Insert: {
          completed_at?: string | null;
          destination_manifest?: Json;
          error?: string | null;
          mode: string;
          run_id: string;
          source_manifest?: Json;
          started_at: string;
          status: string;
        };
        Update: {
          completed_at?: string | null;
          destination_manifest?: Json;
          error?: string | null;
          mode?: string;
          run_id?: string;
          source_manifest?: Json;
          started_at?: string;
          status?: string;
        };
        Relationships: [];
      };
      app_documents: {
        Row: {
          document_key: string;
          owner_id: string;
          payload: Json;
          revision: number;
          updated_at: string;
        };
        Insert: {
          document_key: string;
          owner_id: string;
          payload: Json;
          revision?: number;
          updated_at?: string;
        };
        Update: {
          document_key?: string;
          owner_id?: string;
          payload?: Json;
          revision?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'app_documents_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'edicius_owners';
            referencedColumns: ['owner_id'];
          },
        ];
      };
      collector_requests: {
        Row: {
          claimed_at: string | null;
          completed_at: string | null;
          created_at: string;
          error_code: string | null;
          expires_at: string;
          operation: string;
          owner_id: string;
          payload: Json;
          request_id: string;
          result: Json | null;
          status: string;
        };
        Insert: {
          claimed_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          error_code?: string | null;
          expires_at?: string;
          operation: string;
          owner_id?: string;
          payload: Json;
          request_id?: string;
          result?: Json | null;
          status?: string;
        };
        Update: {
          claimed_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          error_code?: string | null;
          expires_at?: string;
          operation?: string;
          owner_id?: string;
          payload?: Json;
          request_id?: string;
          result?: Json | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'collector_requests_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'edicius_owners';
            referencedColumns: ['owner_id'];
          },
        ];
      };
      collector_runs: {
        Row: {
          collector: string;
          completed_at: string | null;
          error_code: string | null;
          owner_id: string;
          records_failed: number;
          records_seen: number;
          records_written: number;
          run_id: string;
          started_at: string;
          status: string;
        };
        Insert: {
          collector: string;
          completed_at?: string | null;
          error_code?: string | null;
          owner_id: string;
          records_failed?: number;
          records_seen?: number;
          records_written?: number;
          run_id?: string;
          started_at?: string;
          status: string;
        };
        Update: {
          collector?: string;
          completed_at?: string | null;
          error_code?: string | null;
          owner_id?: string;
          records_failed?: number;
          records_seen?: number;
          records_written?: number;
          run_id?: string;
          started_at?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'collector_runs_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'edicius_owners';
            referencedColumns: ['owner_id'];
          },
        ];
      };
      edicius_owners: {
        Row: {
          owner_id: string;
        };
        Insert: {
          owner_id: string;
        };
        Update: {
          owner_id?: string;
        };
        Relationships: [];
      };
      fare_airports: {
        Row: {
          city: string | null;
          code: string;
          country: string | null;
          latitude: number;
          longitude: number;
          name: string | null;
          payload: Json;
          replicated_at: string;
        };
        Insert: {
          city?: string | null;
          code: string;
          country?: string | null;
          latitude: number;
          longitude: number;
          name?: string | null;
          payload: Json;
          replicated_at?: string;
        };
        Update: {
          city?: string | null;
          code?: string;
          country?: string | null;
          latitude?: number;
          longitude?: number;
          name?: string | null;
          payload?: Json;
          replicated_at?: string;
        };
        Relationships: [];
      };
      fare_baseline_points: {
        Row: {
          currency: string;
          destination: string;
          flight_date: string;
          imported_at: string;
          origin: string;
          payload: Json;
          price: number;
          price_date: string;
          record_id: string;
          source: string;
        };
        Insert: {
          currency: string;
          destination: string;
          flight_date: string;
          imported_at?: string;
          origin: string;
          payload: Json;
          price: number;
          price_date: string;
          record_id: string;
          source: string;
        };
        Update: {
          currency?: string;
          destination?: string;
          flight_date?: string;
          imported_at?: string;
          origin?: string;
          payload?: Json;
          price?: number;
          price_date?: string;
          record_id?: string;
          source?: string;
        };
        Relationships: [];
      };
      fare_calendar_captures: {
        Row: {
          captured_at: string;
          currency: string;
          destination: string;
          from_date: string;
          imported_at: string;
          origin: string;
          payload: Json;
          record_id: string;
          source: string;
          source_line: number;
          to_date: string;
        };
        Insert: {
          captured_at: string;
          currency: string;
          destination: string;
          from_date: string;
          imported_at?: string;
          origin: string;
          payload: Json;
          record_id: string;
          source: string;
          source_line: number;
          to_date: string;
        };
        Update: {
          captured_at?: string;
          currency?: string;
          destination?: string;
          from_date?: string;
          imported_at?: string;
          origin?: string;
          payload?: Json;
          record_id?: string;
          source?: string;
          source_line?: number;
          to_date?: string;
        };
        Relationships: [];
      };
      fare_checks: {
        Row: {
          cheapest: number | null;
          checked_at: string;
          destination: string;
          error_code: string | null;
          flight_date: string | null;
          imported_at: string;
          kind: string;
          offers: number;
          origin: string;
          outcome: string;
          payload: Json;
          record_id: string;
        };
        Insert: {
          cheapest?: number | null;
          checked_at: string;
          destination: string;
          error_code?: string | null;
          flight_date?: string | null;
          imported_at?: string;
          kind: string;
          offers?: number;
          origin: string;
          outcome: string;
          payload: Json;
          record_id: string;
        };
        Update: {
          cheapest?: number | null;
          checked_at?: string;
          destination?: string;
          error_code?: string | null;
          flight_date?: string | null;
          imported_at?: string;
          kind?: string;
          offers?: number;
          origin?: string;
          outcome?: string;
          payload?: Json;
          record_id?: string;
        };
        Relationships: [];
      };
      fare_snapshots: {
        Row: {
          captured_at: string;
          captured_at_text: string;
          cheapest_price: number | null;
          currency: string;
          destination: string;
          flight_date: string;
          imported_at: string;
          origin: string;
          payload: Json;
          record_id: string;
          source: string;
          source_line: number;
        };
        Insert: {
          captured_at: string;
          captured_at_text: string;
          cheapest_price?: number | null;
          currency: string;
          destination: string;
          flight_date: string;
          imported_at?: string;
          origin: string;
          payload: Json;
          record_id: string;
          source: string;
          source_line: number;
        };
        Update: {
          captured_at?: string;
          captured_at_text?: string;
          cheapest_price?: number | null;
          currency?: string;
          destination?: string;
          flight_date?: string;
          imported_at?: string;
          origin?: string;
          payload?: Json;
          record_id?: string;
          source?: string;
          source_line?: number;
        };
        Relationships: [];
      };
      finance_documents: {
        Row: {
          document_key: string;
          owner_id: string;
          payload: Json;
          revision: number;
          updated_at: string;
        };
        Insert: {
          document_key: string;
          owner_id: string;
          payload: Json;
          revision?: number;
          updated_at?: string;
        };
        Update: {
          document_key?: string;
          owner_id?: string;
          payload?: Json;
          revision?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      market_bars: {
        Row: {
          expires_at: string;
          extended: boolean;
          fetched_at: string;
          owner_id: string;
          payload: Json;
          provider: string;
          symbol: string;
          timeframe: string;
        };
        Insert: {
          expires_at: string;
          extended: boolean;
          fetched_at: string;
          owner_id: string;
          payload: Json;
          provider: string;
          symbol: string;
          timeframe: string;
        };
        Update: {
          expires_at?: string;
          extended?: boolean;
          fetched_at?: string;
          owner_id?: string;
          payload?: Json;
          provider?: string;
          symbol?: string;
          timeframe?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'market_bars_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'edicius_owners';
            referencedColumns: ['owner_id'];
          },
        ];
      };
      market_quotes: {
        Row: {
          fetched_at: string;
          market_time: number | null;
          owner_id: string;
          payload: Json;
          provider: string;
          symbol: string;
        };
        Insert: {
          fetched_at: string;
          market_time?: number | null;
          owner_id: string;
          payload: Json;
          provider: string;
          symbol: string;
        };
        Update: {
          fetched_at?: string;
          market_time?: number | null;
          owner_id?: string;
          payload?: Json;
          provider?: string;
          symbol?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'market_quotes_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'edicius_owners';
            referencedColumns: ['owner_id'];
          },
        ];
      };
      sentiment_snapshots: {
        Row: {
          as_of: string;
          classification: string | null;
          fetched_at: string;
          owner_id: string;
          payload: Json;
          score: number | null;
          source: string;
        };
        Insert: {
          as_of: string;
          classification?: string | null;
          fetched_at?: string;
          owner_id: string;
          payload: Json;
          score?: number | null;
          source: string;
        };
        Update: {
          as_of?: string;
          classification?: string | null;
          fetched_at?: string;
          owner_id?: string;
          payload?: Json;
          score?: number | null;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sentiment_snapshots_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'edicius_owners';
            referencedColumns: ['owner_id'];
          },
        ];
      };
      tweet_posts: {
        Row: {
          captured_at: string;
          handle: string;
          owner_id: string;
          payload: Json;
          post_id: string;
          posted_at: string;
        };
        Insert: {
          captured_at?: string;
          handle: string;
          owner_id: string;
          payload: Json;
          post_id: string;
          posted_at: string;
        };
        Update: {
          captured_at?: string;
          handle?: string;
          owner_id?: string;
          payload?: Json;
          post_id?: string;
          posted_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tweet_posts_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'edicius_owners';
            referencedColumns: ['owner_id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      airfare_dataset_manifest: { Args: never; Returns: Json };
      claim_collector_request: {
        Args: { p_owner_id: string };
        Returns: {
          claimed_at: string | null;
          completed_at: string | null;
          created_at: string;
          error_code: string | null;
          expires_at: string;
          operation: string;
          owner_id: string;
          payload: Json;
          request_id: string;
          result: Json | null;
          status: string;
        };
        SetofOptions: {
          from: '*';
          to: 'collector_requests';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      complete_collector_request: {
        Args: { p_request_id: string; p_result: Json };
        Returns: {
          claimed_at: string | null;
          completed_at: string | null;
          created_at: string;
          error_code: string | null;
          expires_at: string;
          operation: string;
          owner_id: string;
          payload: Json;
          request_id: string;
          result: Json | null;
          status: string;
        };
        SetofOptions: {
          from: '*';
          to: 'collector_requests';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      delete_app_document: {
        Args: { p_document_key: string; p_expected_revision: number };
        Returns: undefined;
      };
      fail_collector_request: {
        Args: { p_error_code: string; p_request_id: string };
        Returns: {
          claimed_at: string | null;
          completed_at: string | null;
          created_at: string;
          error_code: string | null;
          expires_at: string;
          operation: string;
          owner_id: string;
          payload: Json;
          request_id: string;
          result: Json | null;
          status: string;
        };
        SetofOptions: {
          from: '*';
          to: 'collector_requests';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      read_airfare_calendar: {
        Args: { p_destination: string; p_origin: string };
        Returns: Json;
      };
      read_airfare_history: {
        Args: {
          p_departure: string;
          p_destination: string;
          p_origin: string;
          p_since: string;
          p_snapshot_months: string[];
          p_until: string;
        };
        Returns: Json;
      };
      read_owner_airfare_calendar: {
        Args: { p_destination: string; p_origin: string };
        Returns: Json;
      };
      read_owner_airfare_history: {
        Args: {
          p_departure: string;
          p_destination: string;
          p_origin: string;
          p_since: string;
          p_snapshot_months: string[];
          p_until: string;
        };
        Returns: Json;
      };
      search_owner_airports: {
        Args: { p_limit: number; p_query: string };
        Returns: Json;
      };
      write_app_document: {
        Args: {
          p_document_key: string;
          p_expected_revision: number;
          p_payload: Json;
        };
        Returns: {
          document_key: string;
          owner_id: string;
          payload: Json;
          revision: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'app_documents';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      write_finance_document: {
        Args: {
          p_document_key: string;
          p_expected_revision: number;
          p_payload: Json;
        };
        Returns: {
          document_key: string;
          owner_id: string;
          payload: Json;
          revision: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'finance_documents';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
