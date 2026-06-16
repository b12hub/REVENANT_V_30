
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, CheckCircle, Shield } from 'lucide-react';
import { useAuditLogs } from '../hooks/useAuditLogs';
import AuraCard from './AuraCard';
import { clsx } from 'clsx';

const SecurityPulse = ({ onSelectLog }) => {
    const { logs, loading } = useAuditLogs();

    return (
        <AuraCard className="bg-black/60 h-full flex flex-col">
            <div className="flex items-center space-x-2 mb-6 border-b border-white/10 pb-4">
                <Shield className="w-5 h-5 text-primary animate-pulse" />
                <h3 className="text-white font-mono font-bold tracking-widest text-sm">SECURITY_PULSE</h3>
                <div className="ml-auto flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-primary shadow-neon animate-pulse" />
                    <span className="text-xs text-primary/70 font-mono">LIVE_FEED</span>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2">
                <AnimatePresence initial={false}>
                    {logs.map((log) => {
                        // Parse logic: check if scrub_detected is true.
                        // log.ops_stream is parsed in hook, so we access it directly if it exists.
                        const isThreat = log.ops_stream?.scrub_detected === true || log.ops_stream?.scrub_detected === 'true';

                        return (
                            <motion.div
                                key={log.created_at + log.trace_id} // unique key
                                layout
                                initial={{ opacity: 0, x: -20, height: 0 }}
                                animate={{ opacity: 1, x: 0, height: 'auto' }}
                                exit={{ opacity: 0, scale: 0.9 }}
                                transition={{ duration: 0.3 }}
                                onClick={() => onSelectLog && onSelectLog(log)}
                                className={clsx(
                                    "p-3 rounded-lg border-l-2 font-mono text-xs flex items-center justify-between group cursor-pointer transition-all",
                                    isThreat
                                        ? "bg-red-500/10 border-red-500 hover:bg-red-500/20"
                                        : "bg-primary/5 border-primary hover:bg-primary/10 hover:shadow-[0_0_10px_rgba(0,255,157,0.1)] hover:scale-[1.02]"
                                )}
                            >
                                <div className="flex flex-col space-y-1">
                                    <div className="flex items-center space-x-2">
                                        {isThreat ? (
                                            <AlertCircle className="w-3 h-3 text-red-500" />
                                        ) : (
                                            <CheckCircle className="w-3 h-3 text-primary" />
                                        )}
                                        <span className={isThreat ? "text-red-400 font-bold" : "text-primary/90"}>
                                            {isThreat ? "PII_NEUTRALIZED" : "AUDIT_VERIFIED"}
                                        </span>
                                    </div>
                                    <span className="text-white/40 text-[10px]">{log.trace_id ? log.trace_id.slice(0, 18) : 'ID_UNKNOWN'}...</span>
                                </div>
                                <span className="text-white/30 text-[10px]">
                                    {log.created_at ? new Date(log.created_at).toLocaleTimeString() : '--:--:--'}
                                </span>
                            </motion.div>
                        );
                    })}
                </AnimatePresence>

                {loading && (
                    <div className="text-center text-xs text-gray-500 py-4 italic">
                        Initializing neural link...
                    </div>
                )}

                {!loading && logs.length === 0 && (
                    <div className="text-center text-xs text-gray-500 py-4">
                        No activity detected. Sector clear.
                    </div>
                )}
            </div>
        </AuraCard >
    );
};

export default SecurityPulse;
