import { Component, type ErrorInfo, type ReactNode } from 'react';

import styles from './ErrorView.module.css';
import { PageHeader } from '@/shared/ui/PageHeader';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('AppErrorBoundary caught an error', error, info);
  }

  render(): ReactNode {
    const { error } = this.state;

    if (error) {
      return (
        <div className={styles.page} role="alert">
          <PageHeader
            title="Something went wrong"
            subtitle={error.message || 'An unexpected error occurred.'}
            titleId="error-title"
          />
        </div>
      );
    }

    return this.props.children;
  }
}
