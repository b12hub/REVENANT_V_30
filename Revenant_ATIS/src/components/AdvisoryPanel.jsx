import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, X, CheckCircle, AlertTriangle } from 'lucide-react';

const AdvisoryPanel = ({ isOpen, onClose, data }) => {
    // Determine status color based on some hypothetical risk level if available, default to emerald
    // For now, using the requested Emerald/Slate/Blue theme.

    return (
        <AnimatePresence>
            {isOpen && data && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
                    />

                    {/* Sidebar Panel */}
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed inset-y-0 right-0 w-full max-w-md bg-slate-900/95 backdrop-blur-xl border-l border-emerald-500/30 shadow-2xl z-50 flex flex-col"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between p-6 border-b border-white/10 bg-gradient-to-r from-emerald-900/20 to-transparent">
                            <div className="flex items-center space-x-3">
                                <div className="p-2 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                                    <Shield className="w-6 h-6 text-emerald-400" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-white tracking-tight">Strategic Advisory</h2>
                                    <div className="text-xs font-mono text-emerald-400/80">
                                        TRACE_ID: {data.internal_reference || 'UNKNOWN'}
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-400 hover:text-white"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content Scrollable Area */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-8">

                            {/* Section 1: The Decision */}
                            <section>
                                <h3 className="text-xs font-mono text-emerald-500 uppercase tracking-widest mb-3 flex items-center">
                                    <span className="w-2 h-2 bg-emerald-500 rounded-full mr-2 animate-pulse"></span>
                                    Decision Analysis
                                </h3>
                                <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-gray-200 leading-relaxed text-sm font-sans">
                                    {data.advisory_package?.draft_response || "No analysis content provided."}
                                </div>
                            </section>

                            {/* Section 2: Recommended Actions */}
                            <section>
                                <h3 className="text-xs font-mono text-blue-400 uppercase tracking-widest mb-3">
                                    Protocol_Actions
                                </h3>
                                <div className="space-y-3">
                                    {data.advisory_package?.suggested_actions && data.advisory_package.suggested_actions.length > 0 ? (
                                        data.advisory_package.suggested_actions.map((action, idx) => (
                                            <div key={idx} className="flex items-start space-x-3 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10 hover:bg-blue-500/10 transition-colors group">
                                                <CheckCircle className="w-5 h-5 text-blue-500 mt-0.5 shrink-0 group-hover:text-blue-400" />
                                                <span className="text-sm text-gray-300 group-hover:text-white">{action}</span>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-sm text-gray-500 italic">No specific actions recommended.</div>
                                    )}
                                </div>
                            </section>

                            {/* Section 3: Forensic Data (Audit Trail) */}
                            <section className="pt-6 border-t border-white/5">
                                <h3 className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-2">
                                    Forensic_Audit_Trail
                                </h3>
                                <div className="space-y-1 font-mono text-[10px] text-gray-500">
                                    <div className="flex justify-between">
                                        <span>HASH:</span>
                                        <span className="text-gray-400 truncate max-w-[200px]">{data.advisory_hash || 'N/A'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>IDEM_KEY:</span>
                                        <span className="text-gray-400 truncate max-w-[200px]">{data.idempotence_key || 'N/A'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>TS:</span>
                                        <span className="text-gray-400">{new Date().toISOString()}</span>
                                    </div>
                                </div>
                            </section>

                        </div>

                        {/* Footer Status Bar */}
                        <div className="p-4 border-t border-white/10 bg-black/20 text-xs font-mono text-center text-gray-500">
                            SECURE_CHANNEL_ESTABLISHED • REVENANT_CORE_V2
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default AdvisoryPanel;
