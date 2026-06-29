import * as nexus from 'nexus-rpc';
import type { LoadedDataConverter, ProtoFailure } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
export declare function decodePayload(dataConverter: LoadedDataConverter, payload: temporal.api.common.v1.IPayload | undefined): Promise<unknown>;
export declare function operationErrorToProto(dataConverter: LoadedDataConverter, err: nexus.OperationError): Promise<ProtoFailure>;
export declare function handlerErrorToProto(dataConverter: LoadedDataConverter, err: nexus.HandlerError): Promise<ProtoFailure>;
export declare function coerceToHandlerError(err: unknown): nexus.HandlerError;
