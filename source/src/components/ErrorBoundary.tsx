import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Icon } from './Icon';

interface Props {
    title: string;
    action: string;
    children: ReactNode;
}

interface State {
    failed: boolean;
}

/** Keeps the rest of the site working if one page hits an unexpected error. */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { failed: false };

    static getDerivedStateFromError(): State {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('[page]', error, info.componentStack);
    }

    render() {
        if (this.state.failed) {
            return (
                <div className="page">
                    <div className="card load-error">
                        <Icon name="alert" size={28} />
                        <h2>{this.props.title}</h2>
                        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                            <Icon name="refresh" size={18} />
                            {this.props.action}
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
