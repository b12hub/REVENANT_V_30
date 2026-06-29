import type { temporal } from '@temporalio/proto';
import type { Payload } from '../interfaces';
import type { PayloadCodec } from '../converter/payload-codec';
import type { ProtoFailure } from '../failure';
import type { LoadedDataConverter } from '../converter/data-converter';
import type { UserMetadata } from '../user-metadata';
import type { SerializationContext } from '../converter/serialization-context';
import type { DecodedPayload, DecodedProtoFailure, EncodedPayload, EncodedProtoFailure } from './codec-types';
/**
 * Decode through each codec, starting with the last codec.
 */
export declare function decode(codecs: PayloadCodec[], payloads: Payload[], context?: SerializationContext): Promise<DecodedPayload[]>;
/**
 * Encode through each codec, starting with the first codec.
 */
export declare function encode(codecs: PayloadCodec[], payloads: Payload[], context?: SerializationContext): Promise<EncodedPayload[]>;
/** Run {@link PayloadCodec.encode} on `payloads` */
export declare function encodeOptional(codecs: PayloadCodec[], payloads: Payload[] | null | undefined, context?: SerializationContext): Promise<EncodedPayload[] | null | undefined>;
/** Run {@link PayloadCodec.decode} on `payloads` */
export declare function decodeOptional(codecs: PayloadCodec[], payloads: Payload[] | null | undefined, context?: SerializationContext): Promise<DecodedPayload[] | null | undefined>;
/** Run {@link PayloadCodec.encode} on a single Payload */
export declare function encodeOptionalSingle(codecs: PayloadCodec[], payload: Payload | null | undefined, context?: SerializationContext): Promise<EncodedPayload | null | undefined>;
/** Run {@link PayloadCodec.decode} on a single Payload */
export declare function decodeOptionalSingle(codecs: PayloadCodec[], payload: Payload | null | undefined, context?: SerializationContext): Promise<DecodedPayload | null | undefined>;
/** Run {@link PayloadCodec.decode} and convert from a single Payload */
export declare function decodeOptionalSinglePayload<T>(dataConverter: LoadedDataConverter, payload?: Payload | null | undefined, context?: SerializationContext): Promise<T | null | undefined>;
/**
 * Run {@link PayloadConverter.toPayload} on value, and then encode it.
 */
export declare function encodeToPayload(converter: LoadedDataConverter, value: unknown, context?: SerializationContext): Promise<Payload>;
/**
 * Decode `payloads` and then return {@link arrayFromPayloads}`.
 */
export declare function decodeArrayFromPayloads(converter: LoadedDataConverter, payloads?: Payload[] | null, context?: SerializationContext): Promise<unknown[]>;
/**
 * Decode `payloads` and then return {@link fromPayloadsAtIndex}.
 */
export declare function decodeFromPayloadsAtIndex<T>(converter: LoadedDataConverter, index: number, payloads?: Payload[] | null, context?: SerializationContext): Promise<T>;
/**
 * Run {@link decodeFailure} and then return {@link failureToError}.
 */
export declare function decodeOptionalFailureToOptionalError(converter: LoadedDataConverter, failure: ProtoFailure | undefined | null, context?: SerializationContext): Promise<Error | undefined>;
export declare function decodeOptionalMap(codecs: PayloadCodec[], payloads: Record<string, Payload> | null | undefined, context?: SerializationContext): Promise<Record<string, DecodedPayload> | null | undefined>;
/**
 * Run {@link PayloadConverter.toPayload} on values, and then encode them.
 */
export declare function encodeToPayloads(converter: LoadedDataConverter, ...values: unknown[]): Promise<Payload[] | undefined>;
/**
 * Run {@link PayloadConverter.toPayload} on values with an optional serialization context, and then encode them.
 */
export declare function encodeToPayloadsWithContext(converter: LoadedDataConverter, context: SerializationContext | undefined, values: unknown[]): Promise<Payload[] | undefined>;
/**
 * Run {@link PayloadCodec.decode} and then {@link PayloadConverter.fromPayload} on values in `map`.
 */
export declare function decodeMapFromPayloads<K extends string>(converter: LoadedDataConverter, map: Record<K, Payload> | null | undefined, context?: SerializationContext): Promise<Record<K, unknown> | undefined>;
/** Run {@link PayloadCodec.encode} on all values in `map` */
export declare function encodeMap<K extends string>(codecs: PayloadCodec[], map: Record<K, Payload> | null | undefined, context?: SerializationContext): Promise<Record<K, EncodedPayload> | null | undefined>;
/**
 * Run {@link PayloadConverter.toPayload} and then {@link PayloadCodec.encode} on values in `map`.
 */
export declare function encodeMapToPayloads<K extends string>(converter: LoadedDataConverter, map: Record<K, unknown>, context?: SerializationContext): Promise<Record<K, Payload>>;
/**
 * Run {@link errorToFailure} on `error`, and then {@link encodeFailure}.
 */
export declare function encodeErrorToFailure(dataConverter: LoadedDataConverter, error: unknown, context?: SerializationContext): Promise<ProtoFailure>;
/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export declare function encodeFailure(codecs: PayloadCodec[], failure: ProtoFailure, context?: SerializationContext): Promise<EncodedProtoFailure>;
/**
 * Return a new {@link ProtoFailure} with `codec.decode()` run on all the {@link Payload}s.
 */
export declare function decodeFailure(codecs: PayloadCodec[], failure: ProtoFailure, context?: SerializationContext): Promise<DecodedProtoFailure>;
/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export declare function encodeOptionalFailure(codecs: PayloadCodec[], failure: ProtoFailure | null | undefined, context?: SerializationContext): Promise<EncodedProtoFailure | null | undefined>;
/**
 * Return a new {@link ProtoFailure} with `codec.encode()` run on all the {@link Payload}s.
 */
export declare function decodeOptionalFailure(codecs: PayloadCodec[], failure: ProtoFailure | null | undefined, context?: SerializationContext): Promise<DecodedProtoFailure | null | undefined>;
/**
 * Mark all values in the map as encoded.
 * Use this for headers, which we don't encode.
 */
export declare function noopEncodeMap<K extends string>(map: Record<K, Payload> | null | undefined): Record<K, EncodedPayload> | null | undefined;
export declare function noopEncodeSearchAttrs(attrs: temporal.api.common.v1.ISearchAttributes | null | undefined): temporal.api.common.v1.ISearchAttributes | null | undefined;
/**
 * Mark all values in the map as decoded.
 * Use this for headers, which we don't encode.
 */
export declare function noopDecodeMap<K extends string>(map: Record<K, Payload> | null | undefined): Record<K, DecodedPayload> | null | undefined;
export declare function encodeUserMetadata(dataConverter: LoadedDataConverter, staticSummary: string | undefined, staticDetails: string | undefined, context?: SerializationContext): Promise<temporal.api.sdk.v1.IUserMetadata | undefined>;
export declare function decodeUserMetadata(dataConverter: LoadedDataConverter, metadata: temporal.api.sdk.v1.IUserMetadata | undefined | null, context?: SerializationContext): Promise<UserMetadata>;
