/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ComponentConfiguration,
  IndexedDbComponentProvider,
  MemoryComponentProvider
} from '../../../src/core/component_provider';
import {
  GarbageCollectionScheduler,
  Persistence,
  PersistenceTransaction,
  PersistenceTransactionMode
} from '../../../src/local/persistence';
import { IndexedDbPersistence } from '../../../src/local/indexeddb_persistence';
import { PersistencePromise } from '../../../src/local/persistence_promise';
import { IndexedDbTransactionError } from '../../../src/local/simple_db';
import { debugAssert, fail } from '../../../src/util/assert';
import {
  MemoryEagerDelegate,
  MemoryLruDelegate,
  MemoryPersistence
} from '../../../src/local/memory_persistence';
import { LruParams } from '../../../src/local/lru_garbage_collector';
import { Connection, Stream } from '../../../src/remote/connection';
import { StreamBridge } from '../../../src/remote/stream_bridge';
import * as api from '../../../src/protos/firestore_proto_api';
import { Deferred } from '../../../src/util/promise';
import { AsyncQueue } from '../../../src/util/async_queue';
import { WriteRequest } from '../../../src/remote/persistent_stream';
import { PlatformSupport } from '../../../src/platform/platform';
import { FirestoreError } from '../../../src/util/error';
import { Token } from '../../../src/api/credentials';
import { Observer } from '../../../src/core/event_manager';
import { ViewSnapshot } from '../../../src/core/view_snapshot';
import { Query } from '../../../src/core/query';
import { expectFirestoreError } from '../../util/helpers';
import { Mutation } from '../../../src/model/mutation';

/**
 * A test-only MemoryPersistence implementation that is able to inject
 * transaction failures.
 */
export class MockMemoryPersistence extends MemoryPersistence {
  injectFailures = false;

  runTransaction<T>(
    action: string,
    mode: PersistenceTransactionMode,
    transactionOperation: (
      transaction: PersistenceTransaction
    ) => PersistencePromise<T>
  ): Promise<T> {
    if (this.injectFailures) {
      return Promise.reject(
        new IndexedDbTransactionError(new Error('Simulated retryable error'))
      );
    } else {
      return super.runTransaction(action, mode, transactionOperation);
    }
  }
}

/**
 * A test-only IndexedDbPersistence implementation that is able to inject
 * transaction failures.
 */
export class MockIndexedDbPersistence extends IndexedDbPersistence {
  injectFailures = false;

  runTransaction<T>(
    action: string,
    mode: PersistenceTransactionMode,
    transactionOperation: (
      transaction: PersistenceTransaction
    ) => PersistencePromise<T>
  ): Promise<T> {
    if (this.injectFailures) {
      return Promise.reject(
        new IndexedDbTransactionError(new Error('Simulated retryable error'))
      );
    } else {
      return super.runTransaction(action, mode, transactionOperation);
    }
  }
}

export class MockIndexedDbComponentProvider extends IndexedDbComponentProvider {
  persistence!: MockIndexedDbPersistence;

  createGarbageCollectionScheduler(
    cfg: ComponentConfiguration
  ): GarbageCollectionScheduler | null {
    return null;
  }

  createPersistence(cfg: ComponentConfiguration): MockIndexedDbPersistence {
    debugAssert(
      cfg.persistenceSettings.durable,
      'Can only start durable persistence'
    );

    const persistenceKey = IndexedDbPersistence.buildStoragePrefix(
      cfg.databaseInfo
    );
    const serializer = cfg.platform.newSerializer(cfg.databaseInfo.databaseId);

    return new MockIndexedDbPersistence(
      /* allowTabSynchronization= */ true,
      persistenceKey,
      cfg.clientId,
      cfg.platform,
      LruParams.withCacheSize(cfg.persistenceSettings.cacheSizeBytes),
      cfg.asyncQueue,
      serializer,
      this.sharedClientState
    );
  }
}

export class MockMemoryComponentProvider extends MemoryComponentProvider {
  persistence!: MockMemoryPersistence;

  constructor(private readonly gcEnabled: boolean) {
    super();
  }

  createGarbageCollectionScheduler(
    cfg: ComponentConfiguration
  ): GarbageCollectionScheduler | null {
    return null;
  }

  createPersistence(cfg: ComponentConfiguration): Persistence {
    debugAssert(
      !cfg.persistenceSettings.durable,
      'Can only start memory persistence'
    );
    return new MockMemoryPersistence(
      this.gcEnabled
        ? MemoryEagerDelegate.factory
        : p => new MemoryLruDelegate(p, LruParams.DEFAULT)
    );
  }
}

export class MockConnection implements Connection {
  watchStream: StreamBridge<
    api.ListenRequest,
    api.ListenResponse
  > | null = null;
  writeStream: StreamBridge<api.WriteRequest, api.WriteResponse> | null = null;
  /**
   * Used to make sure a write was actually sent out on the network before the
   * test runner continues.
   */
  writeSendBarriers: Array<Deferred<api.WriteRequest>> = [];

  /**
   * The set of mutations sent out before there was a corresponding
   * writeSendBarrier.
   */
  earlyWrites: api.WriteRequest[] = [];

  /** The total number of requests sent to the watch stream. */
  watchStreamRequestCount = 0;

  /** The total number of requests sent to the write stream. */
  writeStreamRequestCount = 0;

  nextWriteStreamToken = 0;

  constructor(private queue: AsyncQueue) {}

  /**
   * Tracks the currently active watch targets as detected by the mock watch
   * stream, as a mapping from target ID to query Target.
   */
  activeTargets: { [targetId: number]: api.Target } = {};

  /** A Deferred that is resolved once watch opens. */
  watchOpen = new Deferred<void>();

  invokeRPC<Req>(rpcName: string, request: Req): never {
    throw new Error('Not implemented!');
  }

  invokeStreamingRPC<Req>(rpcName: string, request: Req): never {
    throw new Error('Not implemented!');
  }

  waitForWriteRequest(): Promise<api.WriteRequest> {
    const earlyWrite = this.earlyWrites.shift();
    if (earlyWrite) {
      return Promise.resolve(earlyWrite);
    }
    const barrier = new Deferred<WriteRequest>();
    this.writeSendBarriers.push(barrier);
    return barrier.promise;
  }

  waitForWatchOpen(): Promise<void> {
    return this.watchOpen.promise;
  }

  ackWrite(
    commitTime?: api.Timestamp,
    mutationResults?: api.WriteResult[]
  ): void {
    this.writeStream!.callOnMessage({
      // Convert to base64 string so it can later be parsed into ByteString.
      streamToken: PlatformSupport.getPlatform().btoa(
        'write-stream-token-' + this.nextWriteStreamToken
      ),
      commitTime,
      writeResults: mutationResults
    });
    this.nextWriteStreamToken++;
  }

  failWrite(err: FirestoreError): void {
    this.resetAndCloseWriteStream(err);
  }

  private resetAndCloseWriteStream(err?: FirestoreError): void {
    this.writeSendBarriers = [];
    this.earlyWrites = [];
    this.writeStream!.callOnClose(err);
    this.writeStream = null;
  }

  failWatchStream(err?: FirestoreError): void {
    this.resetAndCloseWatchStream(err);
  }

  private resetAndCloseWatchStream(err?: FirestoreError): void {
    this.activeTargets = {};
    this.watchOpen = new Deferred<void>();
    this.watchStream!.callOnClose(err);
    this.watchStream = null;
  }

  openStream<Req, Resp>(
    rpcName: string,
    token: Token | null
  ): Stream<Req, Resp> {
    if (rpcName === 'Write') {
      if (this.writeStream !== null) {
        throw new Error('write stream opened twice');
      }
      let firstCall = true;
      const writeStream = new StreamBridge<WriteRequest, api.WriteResponse>({
        sendFn: (request: WriteRequest) => {
          ++this.writeStreamRequestCount;
          if (firstCall) {
            debugAssert(
              !!request.database,
              'projectId must be set in the first message'
            );
            debugAssert(
              !request.writes,
              'mutations must not be set in first request'
            );
            this.ackWrite(); // just send the token
            firstCall = false;
            return;
          }

          debugAssert(
            !!request.streamToken,
            'streamToken must be set on all writes'
          );
          debugAssert(!!request.writes, 'writes must be set on all writes');

          const barrier = this.writeSendBarriers.shift();
          if (!barrier) {
            // The test runner hasn't set up the barrier yet, so we queue
            // up this mutation to provide to the barrier promise when it
            // arrives.
            this.earlyWrites.push(request);
          } else {
            // The test runner is waiting on a write invocation, now that we
            // have it we can resolve the write send barrier. If we add
            // (automatic) batching support we need to make sure the number of
            // batches matches the number of calls to waitForWriteRequest.
            barrier.resolve(request);
          }
        },
        closeFn: () => {
          this.resetAndCloseWriteStream();
        }
      });
      this.queue.enqueueAndForget(async () => {
        if (this.writeStream === writeStream) {
          writeStream.callOnOpen();
        }
      });
      this.writeStream = writeStream;
      // Replace 'any' with conditional types.
      return writeStream as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    } else {
      debugAssert(rpcName === 'Listen', 'Unexpected rpc name: ' + rpcName);
      if (this.watchStream !== null) {
        throw new Error('Stream opened twice!');
      }
      const watchStream = new StreamBridge<
        api.ListenRequest,
        api.ListenResponse
      >({
        sendFn: (request: api.ListenRequest) => {
          ++this.watchStreamRequestCount;
          if (request.addTarget) {
            const targetId = request.addTarget.targetId!;
            this.activeTargets[targetId] = request.addTarget;
          } else if (request.removeTarget) {
            delete this.activeTargets[request.removeTarget];
          } else {
            fail('Invalid listen request');
          }
        },
        closeFn: () => {
          this.resetAndCloseWatchStream();
        }
      });
      // Call on open immediately after returning
      this.queue.enqueueAndForget(async () => {
        if (this.watchStream === watchStream) {
          watchStream.callOnOpen();
          this.watchOpen.resolve();
        }
      });
      this.watchStream = watchStream;
      // Replace 'any' with conditional types.
      return this.watchStream as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  }
}

/**
 * An Observer<ViewSnapshot> that forwards events to the provided callback.
 */
export class EventAggregator implements Observer<ViewSnapshot> {
  constructor(
    private query: Query,
    private pushEvent: (e: QueryEvent) => void
  ) {}

  next(view: ViewSnapshot): void {
    this.pushEvent({
      query: view.query,
      view
    });
  }

  error(error: Error): void {
    expectFirestoreError(error);
    this.pushEvent({ query: this.query, error: error as FirestoreError });
  }
}

/**
 * FIFO queue that tracks all outstanding mutations for a single test run.
 * As these mutations are shared among the set of active clients, any client can
 * add or retrieve mutations.
 */
// PORTING NOTE: Multi-tab only.
export class SharedWriteTracker {
  private writes: Mutation[][] = [];

  push(write: Mutation[]): void {
    this.writes.push(write);
  }

  peek(): Mutation[] {
    debugAssert(this.writes.length > 0, 'No pending mutations');
    return this.writes[0];
  }

  shift(): Mutation[] {
    debugAssert(this.writes.length > 0, 'No pending mutations');
    return this.writes.shift()!;
  }
}

/**
 * Interface used for object that contain exactly one of either a view snapshot
 * or an error for the given query.
 */
export interface QueryEvent {
  query: Query;
  view?: ViewSnapshot;
  error?: FirestoreError;
}
