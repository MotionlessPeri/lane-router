import type { CallerContext } from "../../router/types.js";
import type { GraphsService } from "./service.js";
import { graphToolArgsSchemas, type GraphToolName } from "./tool-schema.js";
import { GraphError } from "./types.js";

export function callGraphTool(service: GraphsService | undefined, name: GraphToolName, input: Record<string, unknown>, context: CallerContext, origin?: string): unknown {
  if (!service) throw new GraphError("GRAPHS_UNAVAILABLE", "GRAPHS_UNAVAILABLE: graph module is unavailable");
  let result;
  switch (name) {
    case "lane_graph_create": result = service.create(context, input); break;
    case "lane_graph_lock": result = service.lock(context, input); break;
    case "lane_graph_apply": result = service.apply(context, input); break;
    case "lane_graph_read": {
      const args = graphToolArgsSchemas.lane_graph_read.parse(input);
      result = "graphId" in args ? service.readForLane(context, args) : service.listForLane(context, args); break;
    }
  }
  if (!origin) return result;
  if ("graphs" in result) return { ...result, graphs: result.graphs.map(graph => ({ ...graph, viewUrl: new URL(graph.viewPath, origin).href })) };
  return { ...result, viewUrl: new URL(result.viewPath, origin).href };
}
