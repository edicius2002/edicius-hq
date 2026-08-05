import { Component, type ErrorInfo, type ReactNode } from 'react';

import styles from './ErrorView.module.css';

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
          <h1 className={styles.title}>Something went wrong</h1>
          <p className={styles.copy}>{error.message || 'An unexpected error occurred.'}</p>
        </div>
      );
    }

    return this.props.children;
  }
}
