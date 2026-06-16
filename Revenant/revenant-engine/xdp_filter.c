#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/in.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define TARGET_PORT 40123
#define MAX_SENDERS 100000

// Aeron encapsulates payloads. Set to 32 if reading live Aeron UDP frames.
#define AERON_HEADER_OFFSET 32
#define SENDER_OFFSET (104 + AERON_HEADER_OFFSET)
#define NONCE_OFFSET  (120 + AERON_HEADER_OFFSET)

// ─── UNIVERSAL AYA-COMPATIBLE MAP DEFINITION ───
struct bpf_map_def {
    __u32 type;
    __u32 key_size;
    __u32 value_size;
    __u32 max_entries;
    __u32 map_flags;
};

struct bpf_map_def SEC("maps") nonce_map = {
    .type = BPF_MAP_TYPE_HASH,
    .key_size = sizeof(__u32),
    .value_size = sizeof(__u64),
    .max_entries = MAX_SENDERS,
};
// ───────────────────────────────────────────────

SEC("xdp")
int xdp_aeron_filter(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    if (ip->protocol != IPPROTO_UDP)
        return XDP_PASS;

    struct udphdr *udp = (void *)ip + (ip->ihl * 4);
    if ((void *)(udp + 1) > data_end)
        return XDP_PASS;

    // 4. Port Targeting Gate
    if (udp->dest != bpf_htons(TARGET_PORT))
        return XDP_PASS;

    __u8 *payload = (__u8 *)(udp + 1);

    if ((void *)(payload + NONCE_OFFSET + 8) > data_end)
        return XDP_PASS;

    __u32 sender_id = *(__u32 *)(payload + SENDER_OFFSET);
    __u64 nonce     = *(__u64 *)(payload + NONCE_OFFSET);

    // 7. The Hardware Shield
    __u64 *last_nonce = bpf_map_lookup_elem(&nonce_map, &sender_id);
    if (last_nonce) {
        if (nonce <= *last_nonce && nonce != 0) {
            // DROP MALICIOUS PACKET DIRECTLY AT THE NIC
            return XDP_DROP;
        }
    }

    // 8. State Mutation
    bpf_map_update_elem(&nonce_map, &sender_id, &nonce, BPF_ANY);

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";