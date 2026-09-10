import * as React from 'react'
import type { ComponentAnswer, MessageComponent, MessageId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Card, CardContent, CardHeader, CardTitle } from '@taut/ui/components/card'
import { Textarea } from '@taut/ui/components/textarea'
import { cn } from '@taut/ui/lib/utils'
import { RichText } from '@/components/rich-text'
import { useAnswerComponent, useMe } from '@/lib/api'

type Questions = Extract<MessageComponent, { kind: 'questions' }>
type Timer = Extract<MessageComponent, { kind: 'timer' }>

export function InlineMessageComponent({
  messageId,
  component
}: {
  messageId: MessageId
  component: MessageComponent
}) {
  return (
    <Card className="my-2 w-full max-w-lg gap-4 overflow-hidden py-4 shadow-none">
      <CardHeader className="px-4">
        <CardTitle className="min-w-0 text-sm leading-snug break-words">
          {component.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        {component.kind === 'questions' ? (
          <QuestionForm key={messageId} messageId={messageId} component={component} />
        ) : component.kind === 'timer' ? (
          <TimerDisplay component={component} />
        ) : (
          <RichText source={component.body} />
        )}
      </CardContent>
    </Card>
  )
}

function QuestionForm({ messageId, component }: { messageId: MessageId; component: Questions }) {
  const me = useMe()
  const answer = useAnswerComponent()
  const formId = React.useId()
  const [draft, setDraft] = React.useState(() => new Map<string, ComponentAnswer>())
  const canAnswer = me.data?.user.id === component.recipientId
  const answered = component.status === 'answered'
  const disabled = answered || !canAnswer || answer.isPending || answer.isSuccess
  const complete = component.questions.every((question) => {
    const entry = draft.get(question.id)
    return entry !== undefined && (entry.selections.length > 0 || (entry.text?.trim() ?? '') !== '')
  })

  function update(questionId: string, patch: Partial<ComponentAnswer>) {
    setDraft((previous) =>
      new Map(previous).set(questionId, {
        questionId,
        selections: [],
        ...previous.get(questionId),
        ...patch
      })
    )
  }

  const status = answered
    ? 'Answers submitted.'
    : answer.isSuccess
      ? 'Answers sent. The agent can continue.'
      : answer.isPending
        ? 'Sending your answers…'
        : me.isPending
          ? 'Loading your account…'
          : !canAnswer
            ? 'Waiting for the person this question was sent to.'
            : complete
              ? 'Your answers will be sent to the agent together.'
              : 'Choose an option or write a response for each question.'

  return (
    <form
      className="space-y-5"
      aria-label={component.title}
      aria-busy={answer.isPending}
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled || !complete) return
        answer.mutate({
          messageId,
          answers: component.questions.map((question) => {
            const entry = draft.get(question.id)
            return {
              questionId: question.id,
              selections: entry?.selections ?? [],
              ...(entry?.text?.trim() ? { text: entry.text.trim() } : {})
            }
          })
        })
      }}
    >
      {component.questions.map((question, questionIndex) => {
        const entry = answered
          ? component.answers?.find((item) => item.questionId === question.id)
          : draft.get(question.id)
        const inputId = `${formId}-${questionIndex}`
        return (
          <fieldset key={question.id} disabled={disabled} className="min-w-0 space-y-2.5">
            <legend className="mb-2 text-sm font-medium break-words">
              {component.questions.length > 1 ? (
                <span className="mr-2 text-muted-foreground">{questionIndex + 1}.</span>
              ) : null}
              {question.question}
            </legend>
            {answered ? (
              <div className="space-y-2 text-sm">
                {entry?.selections.length ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Selected answers">
                    {entry.selections.map((selection) => (
                      <li key={selection} className="rounded-md bg-muted px-2 py-1 break-words">
                        {selection}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {entry?.text ? (
                  <p className="whitespace-pre-wrap break-words">{entry.text}</p>
                ) : null}
              </div>
            ) : (
              <>
                <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
                  {question.multiSelect
                    ? 'Choose any that apply, or say more.'
                    : 'Choose one, or say more.'}
                </p>
                <div className="grid gap-2">
                  {question.options.map((option, optionIndex) => {
                    const selected = entry?.selections.includes(option.label) ?? false
                    return (
                      <label
                        key={option.label}
                        className={cn(
                          'flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 motion-reduce:transition-none',
                          selected ? 'border-primary/60 bg-primary/5' : 'hover:bg-accent/50',
                          disabled && 'cursor-default opacity-60'
                        )}
                      >
                        <input
                          type={question.multiSelect ? 'checkbox' : 'radio'}
                          name={inputId}
                          value={option.label}
                          checked={selected}
                          aria-describedby={`${inputId}-hint${option.description ? ` ${inputId}-option-${optionIndex}` : ''}`}
                          className="mt-0.5 size-4 shrink-0 accent-primary"
                          onChange={() => {
                            const selections = question.multiSelect
                              ? selected
                                ? (entry?.selections ?? []).filter((item) => item !== option.label)
                                : [...(entry?.selections ?? []), option.label]
                              : [option.label]
                            update(question.id, { selections })
                          }}
                        />
                        <span className="min-w-0 break-words">
                          <span className="font-medium">{option.label}</span>
                          {option.description ? (
                            <span
                              id={`${inputId}-option-${optionIndex}`}
                              className="mt-0.5 block text-xs text-muted-foreground"
                            >
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
                <label htmlFor={`${inputId}-text`} className="block text-xs font-medium">
                  Say more <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Textarea
                  id={`${inputId}-text`}
                  value={entry?.text ?? ''}
                  maxLength={4000}
                  rows={2}
                  aria-describedby={`${inputId}-hint`}
                  placeholder="Add context or give a different answer…"
                  className="min-h-16 resize-y text-sm"
                  onChange={(event) => update(question.id, { text: event.target.value })}
                />
              </>
            )}
          </fieldset>
        )
      })}
      <div className="space-y-2 border-t pt-3">
        <p id={`${formId}-status`} role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
        {answer.error ? (
          <p id={`${formId}-error`} role="alert" className="text-xs text-destructive">
            {answer.error.message}
          </p>
        ) : null}
        {!answered && canAnswer ? (
          <Button
            type="submit"
            size="sm"
            disabled={disabled || !complete}
            aria-describedby={`${formId}-status${answer.error ? ` ${formId}-error` : ''}`}
          >
            {answer.isPending ? 'Sending…' : answer.isSuccess ? 'Answers sent' : 'Send answers'}
          </Button>
        ) : null}
      </div>
    </form>
  )
}

function TimerDisplay({ component }: { component: Timer }) {
  const [now, setNow] = React.useState(() => Date.now())
  const endsAt = Date.parse(component.endsAt)
  const remaining = Math.max(0, Math.ceil((endsAt - now) / 1000))
  const fraction = Math.min(1, remaining / component.durationSeconds)
  const elapsed = remaining === 0
  const hours = Math.floor(remaining / 3600)
  const minutes = Math.floor((remaining % 3600) / 60)
  const seconds = remaining % 60
  const clock =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`

  React.useEffect(() => {
    if (endsAt <= Date.now()) return
    const tick = () => {
      const current = Date.now()
      setNow(current)
      if (current >= endsAt) window.clearInterval(interval)
    }
    const interval = window.setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [endsAt])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative grid size-24 shrink-0 place-items-center">
          <svg
            viewBox="0 0 100 100"
            className="absolute inset-0 size-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              className="text-muted"
            />
            <circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - fraction}
              className="text-primary transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
            />
          </svg>
          <span
            role="timer"
            aria-label={`${clock} remaining`}
            className={cn(
              'font-mono font-medium tabular-nums',
              hours >= 100 ? 'text-sm' : hours > 0 ? 'text-base' : 'text-xl'
            )}
          >
            {clock}
          </span>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p role="status" className="text-sm font-medium">
            {elapsed ? 'Time’s up' : 'Timer running'}
          </p>
          <p className="text-xs text-muted-foreground">
            {elapsed
              ? 'The scheduled follow-up is due.'
              : 'The agent is scheduled to follow up shortly after the timer ends, even if you close this page.'}
          </p>
          <p className="text-xs text-muted-foreground">
            {elapsed ? 'Scheduled for ' : 'Ends at '}
            <time dateTime={component.endsAt}>
              {new Date(endsAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
              })}
            </time>
          </p>
        </div>
      </div>
      <div className="space-y-1.5 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">When it ends</p>
        <RichText source={component.onComplete} className="text-sm" />
      </div>
    </div>
  )
}
