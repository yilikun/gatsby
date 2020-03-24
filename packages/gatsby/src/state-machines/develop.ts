import {
  Machine,
  assign,
  DoneInvokeEvent,
  TransitionConfig,
  AnyEventObject,
} from "xstate"

import { initialize } from "../services/initialize"
import { customizeSchema } from "../services/customize-schema"
import { sourceNodes } from "../services/source-nodes"
import { buildSchema } from "../services/build-schema"
import { createPages } from "../services/create-pages"
import { createPagesStatefully } from "../services/create-pages-statefully"
import { calculateDirtyQueries } from "../services/calculate-dirty-queries"
import { extractQueries } from "../services/extract-queries"
import { runStaticQueries } from "../services/run-static-queries"
import { runPageQueries } from "../services/run-page-queries"
import { startWebpackServer } from "../services/start-webpack-server"
import { writeOutRequires } from "../services/write-out-requires"

import { waitUntilAllJobsComplete } from "../utils/wait-until-jobs-complete"
import { Store } from "../.."
import { actions } from "../redux/actions"

const MAX_RECURSION = 2
const NODE_MUTATION_BATCH_SIZE = 5

interface IBuildContext {
  recursionCount: number
  nodesMutatedDuringQueryRun: boolean
  firstRun: boolean
  nodeMutationBatch: any[]
  runningBatch: any[]
  deferNodeMutation: boolean
  store?: Store
}

const callRealApi = async (event, store: Store): Promise<any> => {
  const { type, payload } = event
  if (type in actions) {
    return actions[type](...payload)(store.dispatch.bind(store))
  }
  console.log(`Invalid type`, type)
  return null
}

const assignMutatedNodes = assign<any, DoneInvokeEvent<any>>(
  (context, event) => {
    return {
      nodesMutatedDuringQueryRun:
        context.nodesMutatedDuringQueryRun || event.data?.nodesMutated,
    }
  }
)

const context: IBuildContext = {
  recursionCount: 0,
  nodesMutatedDuringQueryRun: false,
  firstRun: true,
  nodeMutationBatch: [],
  runningBatch: [],
  deferNodeMutation: false,
}

export const rageAgainstTheStateMachine = async (): Promise<void> => {
  console.error(`I won't do what you tell me!`)
}

/**
 * Event used in all states where we're not ready to process node
 * mutations. Instead we add it a batch to process when we're next idle
 */
const ADD_NODE_MUTATION: TransitionConfig<IBuildContext, AnyEventObject> = {
  actions: assign((ctx, event) => {
    console.log(`event at node mutation add`, event)
    return {
      nodeMutationBatch: [...ctx.nodeMutationBatch, event.payload],
      deferNodeMutation: true,
    }
  }),
}

const skipDeferredApi: TransitionConfig<IBuildContext, AnyEventObject> = {
  internal: true,
  actions: [
    async (ctx, event): Promise<void> => callRealApi(event.payload, ctx.store),
  ],
}

// eslint-disable-next-line new-cap
export const developMachine = Machine<any>(
  {
    id: `build`,
    initial: `initializing`,
    context,
    states: {
      initializing: {
        on: { ADD_NODE_MUTATION: skipDeferredApi },
        invoke: {
          src: initialize,
          onDone: {
            target: `customizingSchema`,
            actions: assign<any, DoneInvokeEvent<any>>((context, event) => {
              const { store, bootstrapSpan } = event.data
              return {
                // nodesMutatedDuringQueryRun:
                //   ctx.nodesMutatedDuringQueryRun || event.data.nodesMutated,
                // firstRun: false,
                store,
                parentSpan: bootstrapSpan,
              }
            }),
          },
          onError: {
            target: `failed`,
          },
        },
      },
      customizingSchema: {
        on: { ADD_NODE_MUTATION: skipDeferredApi },
        invoke: {
          src: customizeSchema,
          id: `customizing-schema`,
          onDone: {
            target: `sourcingNodes`,
          },
          onError: {
            target: `idle`,
          },
        },
      },
      sourcingNodes: {
        on: {
          ADD_NODE_MUTATION: skipDeferredApi,
        },
        invoke: {
          src: sourceNodes,
          id: `sourcing-nodes`,
          onDone: {
            target: `buildingSchema`,
          },
          onError: {
            target: `idle`,
          },
        },
      },
      buildingSchema: {
        on: { ADD_NODE_MUTATION: skipDeferredApi },
        invoke: {
          id: `building-schema`,
          src: buildSchema,
          onDone: {
            target: `creatingPages`,
            actions: assign<any, DoneInvokeEvent<any>>((context, event) => {
              const { graphqlRunner } = event.data
              return {
                graphqlRunner,
              }
            }),
          },
          onError: {
            target: `idle`,
          },
        },
      },
      creatingPages: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          id: `creating-pages`,
          src: createPages,
          onDone: [
            {
              target: `creatingPagesStatefully`,
              cond: (context): boolean => context.firstRun,
              actions: assign<any, DoneInvokeEvent<any>>((context, event) => {
                return {
                  // TODO: Get this correctly from createPages
                  nodesMutatedDuringQueryRun:
                    context.nodesMutatedDuringQueryRun ||
                    !!event.data?.nodesMutated,
                }
              }),
            },
            {
              target: `extractingQueries`,
              actions: assignMutatedNodes,
            },
          ],
          onError: {
            target: `idle`,
          },
        },
      },
      extractingQueries: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          id: `extracting-queries`,
          src: extractQueries,
          onDone: [
            {
              target: `writingRequires`,
            },
          ],
          onError: {
            target: `idle`,
          },
        },
      },
      calculatingDirtyQueries: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          id: `calculating-dirty-queries`,
          src: calculateDirtyQueries,
          onDone: [
            {
              target: `runningStaticQueries`,
              actions: assign<any, DoneInvokeEvent<any>>(
                (context, { data }) => {
                  const { queryIds } = data
                  return {
                    queryIds,
                  }
                }
              ),
            },
          ],
          onError: {
            target: `idle`,
          },
        },
      },
      creatingPagesStatefully: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          src: createPagesStatefully,
          id: `creating-pages-statefully`,
          onDone: {
            target: `extractingQueries`,
          },
          onError: {
            target: `idle`,
          },
        },
      },
      runningStaticQueries: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          src: runStaticQueries,
          id: `running-static-queries`,
          onDone: {
            target: `runningPageQueries`,
            actions: [
              ({ websocketManager }, { data: { results } }): void => {
                if (results) {
                  console.log(`running-static-queries`, {
                    results,
                    websocketManager,
                  })
                  results.forEach((result, id) => {
                    // eslint-disable-next-line no-unused-expressions
                    websocketManager?.emitStaticQueryData({
                      result,
                      id,
                    })
                  })
                }
              },
            ],
          },
          onError: {
            target: `idle`,
          },
        },
      },
      runningPageQueries: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          src: runPageQueries,
          id: `running-page-queries`,
          onDone: [
            {
              target: `waitingForJobs`,
              actions: [
                ({ websocketManager }, { data: { results } }): void => {
                  if (results) {
                    console.log(`running-page-queries`, {
                      results,
                      websocketManager,
                    })
                    results.forEach((result, id) => {
                      // eslint-disable-next-line no-unused-expressions
                      websocketManager?.emitPageData({
                        result,
                        id,
                      })
                    })
                  }
                },
              ],

              // cond: (context, event): boolean => {
              //   return !(
              //     context.nodesMutatedDuringQueryRun || event.data?.nodesMutated
              //   )
              // },
            },
            // {
            //   actions: assign(ctx => {
            //     return {
            //       ...ctx,
            //       recursionCount: ctx.recursionCount + 1,
            //       // nodesMutatedDuringQueryRun: false, // Resetting
            //     }
            //   }),
            //   target: `customizingSchema`,
            //   cond: (ctx: IBuildContext): boolean =>
            //     ctx.recursionCount < MAX_RECURSION,
            // },
            // {
            //   actions: [
            //     assign(ctx => {
            //       return {
            //         ...ctx,
            //         recursionCount: 0,
            //         // nodesMutatedDuringQueryRun: false, // Resetting
            //       }
            //     }),
            //     {
            //       type: `rage-against-the-state-machine`,
            //     },
            //   ],
            //   target: `idle`,
            // },
          ],
          onError: {
            // actions: assign(ctx => {
            //   return {
            //     ...ctx,
            //     recursionCount: 0,
            //     // nodesMutatedDuringQueryRun: false, // Resetting
            //   }
            // }),
            target: `idle`,
          },
        },
      },
      waitingForJobs: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          src: waitUntilAllJobsComplete,
          id: `waiting-for-jobs`,
          onDone: [
            {
              target: `runningWebpack`,
              cond: (ctx): boolean => ctx.firstRun,
            },
            {
              target: `idle`,
            },
          ],
          onError: {
            target: `idle`,
          },
        },
      },
      // writingArtifacts: {
      //   invoke: {
      //     src: writingArtifacts,
      //     id: `writing-artifacts`,
      //     onDone: {
      //       target: `idle`,
      //     },
      //     onError: {
      //       target: `idle`,
      //     },
      //   },
      // },
      refreshing: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          src: async (ctx, event): Promise<void> => {},
          id: `refreshing`,
          onDone: {
            target: `customizingSchema`,
            actions: assign({
              refresh: true,
            }),
          },
          onError: {
            target: `failed`,
          },
        },
      },
      // batchingPageMutations: {
      //   invoke: {
      //     src: batchingPageMutations,
      //     id: `batchingPageMutations`,
      //     onDone: {
      //       target: `runningStaticQueries`,
      //     },
      //     onError: {
      //       target: `idle`,
      //     },
      //   },
      // },

      writingRequires: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          src: writeOutRequires,
          id: `writing-requires`,
          onDone: {
            target: `calculatingDirtyQueries`,
          },
          onError: {
            target: `failed`,
          },
        },
      },
      runningWebpack: {
        on: { ADD_NODE_MUTATION },
        invoke: {
          src: startWebpackServer,
          id: `running-webpack`,
          onDone: {
            target: `idle`,
            actions: assign((context, { data }) => {
              const { compiler, websocketManager } = data
              return {
                compiler,
                firstRun: false,
                websocketManager,
              }
            }),
          },
          onError: {
            target: `failed`,
          },
        },
      },

      committingBatch: {
        on: { ADD_NODE_MUTATION },
        entry: [
          assign(context => {
            console.log(
              `context at entry for cimmiting batch`,
              context.runningBatch,
              context.nodeMutationBatch
            )
            return {
              target: `buildingSchema`,
              nodeMutationBatch: [],
              runningBatch: context.nodeMutationBatch,
            }
          }),
        ],
        invoke: {
          src: async ({ runningBatch, store }): Promise<any> => {
            // Consume the entire batch and run actions
            console.log(`runningBatch`, runningBatch)
            return Promise.all(
              runningBatch.map(payload => callRealApi(payload, store))
            )
          },
          onDone: {
            target: `buildingSchema`,
            actions: assign({
              runningBatch: [],
            }),
          },
        },
      },
      // Doors are open for people to enter
      batchingNodeMutations: {
        on: {
          "": {
            cond: (ctx): boolean =>
              ctx.nodeMutationBatch?.length >= NODE_MUTATION_BATCH_SIZE,
            target: `committingBatch`,
          },
          // More people enter same bus
          ADD_NODE_MUTATION: [
            {
              ...ADD_NODE_MUTATION,
              cond: (ctx): boolean =>
                ctx.nodeMutationBatch?.length >= NODE_MUTATION_BATCH_SIZE,
              target: `committingBatch`,
            },
            ADD_NODE_MUTATION,
          ],
        },

        // Check if bus is either full or if enough time has passed since
        // last passenger entered the bus

        // Fallback
        after: {
          1000: `committingBatch`,
        },
      },

      // There is an empty bus and doors are closed
      idle: {
        entry: [
          assign({
            webhookBody: null,
            refresh: false,
          }),
        ],
        on: {
          "": {
            cond: (ctx): boolean => !!ctx.nodeMutationBatch.length,
            target: `batchingNodeMutations`,
          },
          WEBHOOK_RECEIVED: {
            target: `refreshing`,
            actions: assign((ctx, event) => {
              return { webhookBody: event.body }
            }),
          },
          ADD_NODE_MUTATION: {
            ...ADD_NODE_MUTATION,
            target: `batchingNodeMutations`,
          },
        },
      },
      failed: {
        invoke: {
          src: async (context, event): Promise<void> => {
            console.error(event)
          },
        },
      },
    },
  },
  {
    actions: {
      "rage-against-the-state-machine": rageAgainstTheStateMachine,
    },
  }
)
