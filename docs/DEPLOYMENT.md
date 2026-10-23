# Текущее развёртывание

- Бот: [@hsg_org_bot](https://t.me/hsg_org_bot).
- Worker: `hse-genshin-bot`, адрес [hse-genshin-bot.kokocastles.workers.dev](https://hse-genshin-bot.kokocastles.workers.dev).
- D1: `hse-genshin-bot`; привязка находится в `wrangler.jsonc`.
- Queues: `hse-genshin-delivery`; cron — каждую минуту.
- Первые организаторы настроены через секрет `BOOTSTRAP_ORG_IDS`.
- Предложения участников: [тема №11 беседы оргов](https://t.me/c/1313049342/11).
- Организационные напоминания по умолчанию идут в общую тему той же беседы. Для переноса выполните `/orgchat@hsg_org_bot` в нужной теме.
- Команды и формы организаторов доступны из любых тем этой беседы; ответы остаются в теме обращения.

Секреты хранятся в Cloudflare Secrets и локальном игнорируемом `.dev.vars`. Их значений в этом репозитории нет. Рабочая ветка — `main`; проверки запускаются GitHub Actions. Применение обновлений описано в README.
