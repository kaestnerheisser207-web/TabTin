package cmd

import (
	"github.com/spf13/cobra"

	"github.com/Muse/muse-cli/internal/cmdutil"
)

func newCmdEvent(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "event",
		Short: "查询平台业务事件本体",
		Long: `每个 App 在 packages/apps/<id>/app.json 的 events[] 字段声明业务事件，
event Tracker 通过 --on <event_key> 订阅这些事件。

示例：
  muse event list
  muse event list --app tabdoc
  muse event show tabdoc.document.published`,
	}

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:     "list",
		Short:   "列出所有 App 声明的业务事件",
		Example: "  muse event list\n  muse event list --app tabdoc",
		Route:   cmdutil.RouteCliServer, Method: "GET", Path: "/api/registry/events",
		HasFormat:    true,
		Idempotent:   true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "app", Type: cmdutil.FlagString,
				Desc: "按 app_id 过滤（如 tabdoc）"},
		},
	})

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:     "show <event-key>",
		Short:   "查看业务事件详情（payload schema + filterable fields）",
		Example: "  muse event show tabdoc.document.published",
		Route:   cmdutil.RouteCliServer, Method: "GET",
		Path:         "/api/registry/events/{event_key}",
		ArgsMapping:  []string{"event_key"},
		HasFormat:    true,
		Idempotent:   true,
		RequiresAuth: true,
	})

	return cmd
}
