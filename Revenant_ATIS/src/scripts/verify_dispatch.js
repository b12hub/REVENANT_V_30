
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple .env parser to avoid installing dotenv
function loadEnv() {
    try {
        const envPath = path.resolve(__dirname, '../../.env');
        if (!fs.existsSync(envPath)) return {};
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const env = {};
        envContent.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                env[match[1].trim()] = match[2].trim();
            }
        });
        return env;
    } catch (e) {
        console.error("Error reading .env:", e);
        return {};
    }
}

const env = loadEnv();
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
    console.log("Make sure .env file exists and contains these variables.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function checkDispatchLogs() {
    console.log("Checking bank_dispatch_logs for 'INTERNAL_UI' messages...");

    const { data, error } = await supabase
        .from('bank_dispatch_logs')
        .select('*')
        .eq('channel', 'INTERNAL_UI')
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error("Error fetching logs:", error);
        return;
    }

    if (!data || data.length === 0) {
        console.log("No logs found for channel 'INTERNAL_UI'.");
        return;
    }

    console.log(`Found ${data.length} logs.`);
    data.forEach((log, index) => {
        console.log(`\nLog #${index + 1}:`);
        console.log(`  ID: ${log.id}`);
        console.log(`  Status: ${log.status}`);
        console.log(`  Created At: ${log.created_at}`);
        if (log.dispatch_result) {
            console.log(`  Payload (dispatch_result): PRESENT`);
            console.log(`  Package:`, JSON.stringify(log.dispatch_result, null, 2));
        } else {
            console.log(`  Payload (dispatch_result): NULL/MISSING`);
        }
    });
}

checkDispatchLogs();
