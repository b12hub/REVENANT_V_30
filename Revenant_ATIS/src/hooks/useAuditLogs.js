import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export const useAuditLogs = (limit = 15) => {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetchLogs = async () => {
        try {
            const { data, error } = await supabase
                .from('audit_ledger')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;

            // Map data if necessary, though direct access is usually fine.
            // Ensuring structure matches request: trace_id, ops_stream.status
            const mappedData = data.map(log => ({
                ...log,
                // Ensure ops_stream is an object if it comes as a JSON string, otherwise it's already an object
                ops_stream: typeof log.ops_stream === 'string' ? JSON.parse(log.ops_stream) : log.ops_stream,
                economics: typeof log.economics === 'string' ? JSON.parse(log.economics) : log.economics
            }));

            setLogs(mappedData);
        } catch (err) {
            console.error('Error fetching audit logs:', err);
            setError(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();

        const channel = supabase
            .channel('audit-ledger-logs-changes')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'audit_ledger',
                },
                (payload) => {
                    console.log('New audit log inserted, refreshing list...', payload);
                    fetchLogs();
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [limit]);

    return { logs, loading, error };
};
