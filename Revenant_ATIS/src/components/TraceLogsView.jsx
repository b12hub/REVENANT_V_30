import React from 'react';
import { useAuditLogs } from '../hooks/useAuditLogs';
import { formatUZS } from '../utils/formatters';

const TraceLogsView = ({ onSelectLog }) => {
    // Forensic investigation needs more logs, dense view
    const { logs, loading } = useAuditLogs(50);

    return (
        <div className="p-6 lg:p-8 max-w-[1600px] mx-auto h-[calc(100vh-100px)] flex flex-col">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-white font-mono tracking-tight">FORENSIC_TRACE_LOGS</h2>
                <div className="text-xs text-gray-500 font-mono">RETENTION: 90 DAYS</div>
            </div>

            <div className="flex-1 overflow-auto bg-black/40 border border-white/10 rounded-xl custom-scrollbar relative">
                <div className="absolute inset-0 pointer-events-none border border-white/5 rounded-xl z-20" />
                <table className="w-full text-left border-collapse relative z-10">
                    <thead className="bg-black/80 sticky top-0 backdrop-blur-md z-1">
                        <tr>
                            <th className="p-4 text-xs font-mono text-gray-400 uppercase tracking-widest border-b border-white/10">Trace ID</th>
                            <th className="p-4 text-xs font-mono text-gray-400 uppercase tracking-widest border-b border-white/10">Timestamp</th>
                            <th className="p-4 text-xs font-mono text-gray-400 uppercase tracking-widest border-b border-white/10 text-right">Net Savings</th>
                            <th className="p-4 text-xs font-mono text-gray-400 uppercase tracking-widest border-b border-white/10 text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                        {logs.map((log, i) => (
                            <tr key={log.id || log.trace_id || i} className="hover:bg-white/5 transition-colors font-mono text-sm group">
                                <td className="p-4 text-primary/70 group-hover:text-primary transition-colors">
                                    {log.trace_id?.substring(0, 8)}...{log.trace_id?.substring(log.trace_id.length - 8)}
                                </td>
                                <td className="p-4 text-gray-400">{new Date(log.created_at).toLocaleString()}</td>
                                <td className="p-4 text-right text-white font-medium">
                                    {formatUZS(parseFloat(log.economics?.net_savings || 0))}
                                </td>
                                <td className="p-4 text-right">
                                    <button
                                        onClick={() => onSelectLog(log)}
                                        className="px-3 py-1 text-xs border border-white/20 hover:bg-white/10 hover:border-primary/50 text-gray-300 hover:text-primary rounded transition-all"
                                    >
                                        INSPECT
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {loading && (
                    <div className="flex items-center justify-center p-20">
                        <div className="text-primary font-mono animate-pulse">DECRYPTING_LOG_STREAMS...</div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TraceLogsView;
