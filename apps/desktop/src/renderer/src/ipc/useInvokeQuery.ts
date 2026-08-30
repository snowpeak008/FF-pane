/**
 * useInvokeQuery —— 组件里消费一次性查询的标准 hook（W3.1c）。
 *
 * 行为：
 * - 挂载即发起，通道或请求体变化时重新发起，卸载/切换后到达的响应一律丢弃；
 * - 请求体经 JSON 序列化作为依赖键，因此可以直接传字面量对象，不必自己 useMemo；
 * - refetch() 复用同一状态机：有数据时进 refreshing、错误时进 retrying，
 *   内容不会被骨架屏替换（设计系统 §5.8）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { InvokeChannel, InvokeResponse } from "../../../shared-ipc/contracts";
import {
  IDLE_QUERY_STATE,
  type InvokeQueryArgs,
  invokeQuery,
  type QueryAction,
  type QueryState,
  queryReducer,
} from "./query";

export interface QueryResult<T> {
  readonly state: QueryState<T>;
  /** 重新拉取（刷新/重试），不清空已有内容。 */
  readonly refetch: () => void;
}

export function useInvokeQuery<K extends InvokeChannel>(
  channel: K,
  ...args: InvokeQueryArgs<K>
): QueryResult<InvokeResponse<K>> {
  type Data = InvokeResponse<K>;
  const reducer: (prev: QueryState<Data>, action: QueryAction<Data>) => QueryState<Data> =
    queryReducer;
  const initial: QueryState<Data> = IDLE_QUERY_STATE;
  const [state, dispatch] = useReducer(reducer, initial);

  const requestKey = JSON.stringify(args[0] ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖键刻意取请求体的 JSON 序列化，使调用方可直接传字面量请求体而不触发重复请求
  const stableArgs = useMemo(() => args, [requestKey]);

  // 请求序号：自增即作废所有在飞请求（卸载、切通道、重新拉取共用同一机制）
  const requestSeq = useRef(0);

  const run = useCallback(() => {
    requestSeq.current += 1;
    const seq = requestSeq.current;
    dispatch({ type: "start" });
    void invokeQuery(channel, ...stableArgs).then((settled) => {
      if (requestSeq.current === seq) {
        dispatch({ type: "settle", state: settled });
      }
    });
  }, [channel, stableArgs]);

  useEffect(() => {
    run();
    return () => {
      requestSeq.current += 1;
    };
  }, [run]);

  return { state, refetch: run };
}
