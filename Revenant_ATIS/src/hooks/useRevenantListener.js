import { useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export const useRevenantListener = (onAdvisoryReceived) => {
    useEffect(() => {
        const channel = supabase
            .channel('internal_advisory_channel')
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'bank_dispatch_logs',
                    filter: "channel=eq.INTERNAL_UI" // Filter at the database level if possible, or client side
                },
                (payload) => {
                    console.log('Revenant Listener received payload:', payload);

                    // Client-side filtering to ensure status is DELIVERED
                    if (payload.new && payload.new.status === 'DELIVERED') {
                         // Extract the advisory package
                        const dispatchResult = payload.new.dispatch_result;
                        
                        if (dispatchResult) {
                            onAdvisoryReceived(dispatchResult);
                        }
                    }
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [onAdvisoryReceived]);
};
