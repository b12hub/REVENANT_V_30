
import React from 'react';
import { useAuditLogs } from '../hooks/useAuditLogs';
import { formatUZS } from '../utils/formatters';

const LiveAuditView = ({ onSelectLog }) => {
    const { logs, loading } = useAuditLogs(10);
    // Removed require, using import

    return (
        <div className="p-6 lg:p-8 max-w-[1600px] mx-auto h-[calc(100vh-100px)]">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-white font-mono tracking-tight">LIVE_AUDIT_STREAM</h2>
                <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20">
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-neon" />
                    <span className="text-xs font-mono font-bold text-primary tracking-wider">LIVE_FEED_ACTIVE</span>
                </div>
            </div>

            <div className="aspect-video bg-black/40 rounded-xl border border-white/10 overflow-hidden relative">
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20" />

                <div className="relative z-10 p-6 space-y-4">
                    {loading && <div className="text-primary font-mono animate-pulse">ESTABLISHING_UPLINK...</div>}

                    {!loading && logs.map((log) => {
                        const isScrubbed = log.ops_stream?.scrub_detected;

                        // Simplified Activity Type
                        const activityType = isScrubbed ? "PII_NEUTRALIZATION" : "STANDARD_AUDIT";

                        return (
                            <div key={log.id || log.trace_id} className="flex items-center justify-between p-4 bg-black/60 border border-white/5 rounded-lg hover:bg-white/5 transition-colors group">
                                <div className="flex items-center space-x-4">
                                    <div className={`w-2 h-2 rounded-full ${isScrubbed ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-blue-500'}`} />
                                    <span className={`font-mono text-sm ${isScrubbed ? 'text-emerald-400' : 'text-blue-400'}`}>
                                        {isScrubbed ? 'PROTECTED' : 'MONITORED'}
                                    </span>
                                    <span className="text-xs text-gray-500 font-mono">|</span>
                                    <span className="text-sm text-gray-300 font-medium">{activityType}</span>
                                </div>

                                <div className="flex items-center space-x-6">
                                    <div className="flex flex-col items-end">
                                        <span className="text-xs text-gray-500 font-mono uppercase">Net Savings</span>
                                        <span className="text-white font-mono font-bold">{formatUZS(parseFloat(log.economics?.net_savings || 0))}</span>
                                    </div>
                                    <button
                                        onClick={() => onSelectLog(log)}
                                        className="px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded text-gray-300 transition-colors"
                                    >
                                        DETAILS
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default LiveAuditView;
