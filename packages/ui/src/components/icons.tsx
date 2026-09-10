import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from '@hugeicons/react'
import {
  ActivityIcon as ActivityIconSvg,
  AlarmClockIcon as AlarmClockIconSvg,
  Alert02Icon as Alert02IconSvg,
  AlertCircleIcon as AlertCircleIconSvg,
  ArchiveIcon as ArchiveIconSvg,
  ArchiveRestoreIcon as ArchiveRestoreIconSvg,
  ArrowLeftIcon as ArrowLeftIconSvg,
  ArrowLeftRightIcon as ArrowLeftRightIconSvg,
  ArrowRightIcon as ArrowRightIconSvg,
  ArrowUpDownIcon as ArrowUpDownIconSvg,
  AtSignIcon as AtSignIconSvg,
  BellIcon as BellIconSvg,
  BellOffIcon as BellOffIconSvg,
  BoldIcon as BoldIconSvg,
  BotIcon as BotIconSvg,
  Building02Icon as Building02IconSvg,
  BuildingIcon as BuildingIconSvg,
  CalendarAddIcon as CalendarAddIconSvg,
  CalendarCheckInIcon as CalendarCheckInIconSvg,
  CalendarClockIcon as CalendarClockIconSvg,
  CalendarIcon as CalendarIconSvg,
  CalendarRemove02Icon as CalendarRemove02IconSvg,
  CheckIcon as CheckIconSvg,
  ChevronDownIcon as ChevronDownIconSvg,
  ChevronLeftIcon as ChevronLeftIconSvg,
  ChevronRightIcon as ChevronRightIconSvg,
  ChevronUpIcon as ChevronUpIconSvg,
  CircleCheckIcon as CircleCheckIconSvg,
  CircleDashedIcon as CircleDashedIconSvg,
  CircleDotIcon as CircleDotIconSvg,
  CircleIcon as CircleIconSvg,
  CirclePlusIcon as CirclePlusIconSvg,
  CircleSlashIcon as CircleSlashIconSvg,
  CircleXIcon as CircleXIconSvg,
  CloudDownloadIcon as CloudDownloadIconSvg,
  CodeIcon as CodeIconSvg,
  CodeSquareIcon as CodeSquareIconSvg,
  CompassIcon as CompassIconSvg,
  CopyIcon as CopyIconSvg,
  CreditCardIcon as CreditCardIconSvg,
  Delete02Icon as Delete02IconSvg,
  DiamondIcon as DiamondIconSvg,
  DownloadIcon as DownloadIconSvg,
  EllipsisIcon as EllipsisIconSvg,
  EllipsisVerticalIcon as EllipsisVerticalIconSvg,
  ExternalLinkIcon as ExternalLinkIconSvg,
  EyeIcon as EyeIconSvg,
  EyeOffIcon as EyeOffIconSvg,
  FileArchiveIcon as FileArchiveIconSvg,
  FileIcon as FileIconSvg,
  FileTextIcon as FileTextIconSvg,
  FolderGitIcon as FolderGitIconSvg,
  FolderIcon as FolderIconSvg,
  ForwardIcon as ForwardIconSvg,
  GaugeIcon as GaugeIconSvg,
  GitBranchIcon as GitBranchIconSvg,
  GlobeIcon as GlobeIconSvg,
  HandIcon as HandIconSvg,
  HashIcon as HashIconSvg,
  Heading01Icon as Heading01IconSvg,
  Heading02Icon as Heading02IconSvg,
  Heading03Icon as Heading03IconSvg,
  HeadphonesIcon as HeadphonesIconSvg,
  HomeIcon as HomeIconSvg,
  ImageIcon as ImageIconSvg,
  InfoIcon as InfoIconSvg,
  ItalicIcon as ItalicIconSvg,
  KeyRoundIcon as KeyRoundIconSvg,
  LayersIcon as LayersIconSvg,
  LayoutTwoColumnIcon as LayoutTwoColumnIconSvg,
  LinkIcon as LinkIconSvg,
  ListChecksIcon as ListChecksIconSvg,
  ListIcon as ListIconSvg,
  ListOrderedIcon as ListOrderedIconSvg,
  ListTodoIcon as ListTodoIconSvg,
  Loading03Icon as Loading03IconSvg,
  LockIcon as LockIconSvg,
  LogOutIcon as LogOutIconSvg,
  MailCheckIcon as MailCheckIconSvg,
  MailIcon as MailIconSvg,
  MessageSquareIcon as MessageSquareIconSvg,
  MessageSquareTextIcon as MessageSquareTextIconSvg,
  MessagesSquareIcon as MessagesSquareIconSvg,
  MicIcon as MicIconSvg,
  MicOffIcon as MicOffIconSvg,
  MinusIcon as MinusIconSvg,
  MonitorIcon as MonitorIconSvg,
  MonitorUpIcon as MonitorUpIconSvg,
  MoonIcon as MoonIconSvg,
  MoreHorizontalIcon as MoreHorizontalIconSvg,
  PanelLeftIcon as PanelLeftIconSvg,
  PaperclipIcon as PaperclipIconSvg,
  PartyPopperIcon as PartyPopperIconSvg,
  PauseCircleIcon as PauseCircleIconSvg,
  PauseIcon as PauseIconSvg,
  PenLineIcon as PenLineIconSvg,
  PencilIcon as PencilIconSvg,
  PhoneOffIcon as PhoneOffIconSvg,
  PlayIcon as PlayIconSvg,
  PlugIcon as PlugIconSvg,
  PlugZap as PlugZapSvg,
  PlusIcon as PlusIconSvg,
  PowerIcon as PowerIconSvg,
  RefreshCwIcon as RefreshCwIconSvg,
  RotateCcwIcon as RotateCcwIconSvg,
  ScrollTextIcon as ScrollTextIconSvg,
  SearchIcon as SearchIconSvg,
  SendIcon as SendIconSvg,
  SentIcon as SentIconSvg,
  ServerIcon as ServerIconSvg,
  SettingsIcon as SettingsIconSvg,
  ShieldAlertIcon as ShieldAlertIconSvg,
  SignalHighIcon as SignalHighIconSvg,
  SignalLowIcon as SignalLowIconSvg,
  SignalMediumIcon as SignalMediumIconSvg,
  SlidersHorizontalIcon as SlidersHorizontalIconSvg,
  SmilePlusIcon as SmilePlusIconSvg,
  SparklesIcon as SparklesIconSvg,
  SquareIcon as SquareIconSvg,
  SquareKanbanIcon as SquareKanbanIconSvg,
  SquarePenIcon as SquarePenIconSvg,
  StarIcon as StarIconSvg,
  StickyNoteIcon as StickyNoteIconSvg,
  StrikethroughIcon as StrikethroughIconSvg,
  SunIcon as SunIconSvg,
  TagIcon as TagIconSvg,
  TerminalIcon as TerminalIconSvg,
  TextQuoteIcon as TextQuoteIconSvg,
  TimerIcon as TimerIconSvg,
  TrashIcon as TrashIconSvg,
  TriangleAlertIcon as TriangleAlertIconSvg,
  UndoIcon as UndoIconSvg,
  UnplugIcon as UnplugIconSvg,
  UploadIcon as UploadIconSvg,
  UserIcon as UserIconSvg,
  UserMinusIcon as UserMinusIconSvg,
  UserPlusIcon as UserPlusIconSvg,
  UsersIcon as UsersIconSvg,
  VideoIcon as VideoIconSvg,
  VideoOffIcon as VideoOffIconSvg,
  VolumeHighIcon as VolumeHighIconSvg,
  XIcon as XIconSvg
} from '@hugeicons/core-free-icons'

export type IconProps = Omit<HugeiconsIconProps, 'icon'>

/** Shared glyphs for every Taut surface. Call sites own size and color. */
function createIcon(icon: IconSvgElement) {
  return function Icon(props: IconProps) {
    return (
      <HugeiconsIcon
        icon={icon}
        size={24}
        strokeWidth={1.5}
        aria-hidden={
          props['aria-label'] === undefined && props['aria-labelledby'] === undefined
            ? true
            : undefined
        }
        {...props}
      />
    )
  }
}

export const ActivityIcon = /* @__PURE__ */ createIcon(ActivityIconSvg)
export const AlarmClockIcon = /* @__PURE__ */ createIcon(AlarmClockIconSvg)
export const AlertCircleIcon = /* @__PURE__ */ createIcon(AlertCircleIconSvg)
export const AlertTriangleIcon = /* @__PURE__ */ createIcon(Alert02IconSvg)
export const ArchiveIcon = /* @__PURE__ */ createIcon(ArchiveIconSvg)
export const ArchiveRestoreIcon = /* @__PURE__ */ createIcon(ArchiveRestoreIconSvg)
export const ArrowLeftIcon = /* @__PURE__ */ createIcon(ArrowLeftIconSvg)
export const ArrowLeftRightIcon = /* @__PURE__ */ createIcon(ArrowLeftRightIconSvg)
export const ArrowRightIcon = /* @__PURE__ */ createIcon(ArrowRightIconSvg)
export const AtSignIcon = /* @__PURE__ */ createIcon(AtSignIconSvg)
export const BellIcon = /* @__PURE__ */ createIcon(BellIconSvg)
export const BellOffIcon = /* @__PURE__ */ createIcon(BellOffIconSvg)
export const BoldIcon = /* @__PURE__ */ createIcon(BoldIconSvg)
export const BotIcon = /* @__PURE__ */ createIcon(BotIconSvg)
export const Building2Icon = /* @__PURE__ */ createIcon(Building02IconSvg)
export const BuildingIcon = /* @__PURE__ */ createIcon(BuildingIconSvg)
export const CalendarAddIcon = /* @__PURE__ */ createIcon(CalendarAddIconSvg)
export const CalendarCheckInIcon = /* @__PURE__ */ createIcon(CalendarCheckInIconSvg)
export const CalendarClockIcon = /* @__PURE__ */ createIcon(CalendarClockIconSvg)
export const CalendarIcon = /* @__PURE__ */ createIcon(CalendarIconSvg)
export const CalendarX2Icon = /* @__PURE__ */ createIcon(CalendarRemove02IconSvg)
export const CheckIcon = /* @__PURE__ */ createIcon(CheckIconSvg)
export const ChevronDownIcon = /* @__PURE__ */ createIcon(ChevronDownIconSvg)
export const ChevronLeftIcon = /* @__PURE__ */ createIcon(ChevronLeftIconSvg)
export const ChevronRightIcon = /* @__PURE__ */ createIcon(ChevronRightIconSvg)
export const ChevronUpIcon = /* @__PURE__ */ createIcon(ChevronUpIconSvg)
export const ChevronsUpDownIcon = /* @__PURE__ */ createIcon(ArrowUpDownIconSvg)
export const CircleCheckIcon = /* @__PURE__ */ createIcon(CircleCheckIconSvg)
export const CircleDashedIcon = /* @__PURE__ */ createIcon(CircleDashedIconSvg)
export const CircleDotIcon = /* @__PURE__ */ createIcon(CircleDotIconSvg)
export const CircleIcon = /* @__PURE__ */ createIcon(CircleIconSvg)
export const CirclePauseIcon = /* @__PURE__ */ createIcon(PauseCircleIconSvg)
export const CirclePlusIcon = /* @__PURE__ */ createIcon(CirclePlusIconSvg)
export const CircleSlashIcon = /* @__PURE__ */ createIcon(CircleSlashIconSvg)
export const CircleXIcon = /* @__PURE__ */ createIcon(CircleXIconSvg)
export const CloudDownloadIcon = /* @__PURE__ */ createIcon(CloudDownloadIconSvg)
export const CodeIcon = /* @__PURE__ */ createIcon(CodeIconSvg)
export const Columns2Icon = /* @__PURE__ */ createIcon(LayoutTwoColumnIconSvg)
export const CompassIcon = /* @__PURE__ */ createIcon(CompassIconSvg)
export const CopyIcon = /* @__PURE__ */ createIcon(CopyIconSvg)
export const CreditCardIcon = /* @__PURE__ */ createIcon(CreditCardIconSvg)
export const DiamondIcon = /* @__PURE__ */ createIcon(DiamondIconSvg)
export const DownloadIcon = /* @__PURE__ */ createIcon(DownloadIconSvg)
export const EllipsisIcon = /* @__PURE__ */ createIcon(EllipsisIconSvg)
export const EllipsisVerticalIcon = /* @__PURE__ */ createIcon(EllipsisVerticalIconSvg)
export const ExternalLinkIcon = /* @__PURE__ */ createIcon(ExternalLinkIconSvg)
export const EyeIcon = /* @__PURE__ */ createIcon(EyeIconSvg)
export const EyeOffIcon = /* @__PURE__ */ createIcon(EyeOffIconSvg)
export const FileArchiveIcon = /* @__PURE__ */ createIcon(FileArchiveIconSvg)
export const FileIcon = /* @__PURE__ */ createIcon(FileIconSvg)
export const FileTextIcon = /* @__PURE__ */ createIcon(FileTextIconSvg)
export const FolderGitIcon = /* @__PURE__ */ createIcon(FolderGitIconSvg)
export const FolderIcon = /* @__PURE__ */ createIcon(FolderIconSvg)
export const ForwardIcon = /* @__PURE__ */ createIcon(ForwardIconSvg)
export const GaugeIcon = /* @__PURE__ */ createIcon(GaugeIconSvg)
export const GitBranchIcon = /* @__PURE__ */ createIcon(GitBranchIconSvg)
export const GlobeIcon = /* @__PURE__ */ createIcon(GlobeIconSvg)
export const HandIcon = /* @__PURE__ */ createIcon(HandIconSvg)
export const HashIcon = /* @__PURE__ */ createIcon(HashIconSvg)
export const Heading1Icon = /* @__PURE__ */ createIcon(Heading01IconSvg)
export const Heading2Icon = /* @__PURE__ */ createIcon(Heading02IconSvg)
export const Heading3Icon = /* @__PURE__ */ createIcon(Heading03IconSvg)
export const HeadphonesIcon = /* @__PURE__ */ createIcon(HeadphonesIconSvg)
export const HomeIcon = /* @__PURE__ */ createIcon(HomeIconSvg)
export const ImageIcon = /* @__PURE__ */ createIcon(ImageIconSvg)
export const InfoIcon = /* @__PURE__ */ createIcon(InfoIconSvg)
export const ItalicIcon = /* @__PURE__ */ createIcon(ItalicIconSvg)
export const KeyRoundIcon = /* @__PURE__ */ createIcon(KeyRoundIconSvg)
export const LayersIcon = /* @__PURE__ */ createIcon(LayersIconSvg)
export const LinkIcon = /* @__PURE__ */ createIcon(LinkIconSvg)
export const ListChecksIcon = /* @__PURE__ */ createIcon(ListChecksIconSvg)
export const ListIcon = /* @__PURE__ */ createIcon(ListIconSvg)
export const ListOrderedIcon = /* @__PURE__ */ createIcon(ListOrderedIconSvg)
export const ListTodoIcon = /* @__PURE__ */ createIcon(ListTodoIconSvg)
export const Loader2 = /* @__PURE__ */ createIcon(Loading03IconSvg)
export const Loader2Icon = /* @__PURE__ */ createIcon(Loading03IconSvg)
export const LockIcon = /* @__PURE__ */ createIcon(LockIconSvg)
export const LogOutIcon = /* @__PURE__ */ createIcon(LogOutIconSvg)
export const MailCheckIcon = /* @__PURE__ */ createIcon(MailCheckIconSvg)
export const MailIcon = /* @__PURE__ */ createIcon(MailIconSvg)
export const MessageSquareIcon = /* @__PURE__ */ createIcon(MessageSquareIconSvg)
export const MessageSquareTextIcon = /* @__PURE__ */ createIcon(MessageSquareTextIconSvg)
export const MessagesSquareIcon = /* @__PURE__ */ createIcon(MessagesSquareIconSvg)
export const MicIcon = /* @__PURE__ */ createIcon(MicIconSvg)
export const MicOffIcon = /* @__PURE__ */ createIcon(MicOffIconSvg)
export const MinusIcon = /* @__PURE__ */ createIcon(MinusIconSvg)
export const MonitorIcon = /* @__PURE__ */ createIcon(MonitorIconSvg)
export const MonitorUpIcon = /* @__PURE__ */ createIcon(MonitorUpIconSvg)
export const MoonIcon = /* @__PURE__ */ createIcon(MoonIconSvg)
export const MoreHorizontalIcon = /* @__PURE__ */ createIcon(MoreHorizontalIconSvg)
export const PanelLeftIcon = /* @__PURE__ */ createIcon(PanelLeftIconSvg)
export const PaperclipIcon = /* @__PURE__ */ createIcon(PaperclipIconSvg)
export const PartyPopperIcon = /* @__PURE__ */ createIcon(PartyPopperIconSvg)
export const PauseIcon = /* @__PURE__ */ createIcon(PauseIconSvg)
export const PenLineIcon = /* @__PURE__ */ createIcon(PenLineIconSvg)
export const PencilIcon = /* @__PURE__ */ createIcon(PencilIconSvg)
export const PhoneOffIcon = /* @__PURE__ */ createIcon(PhoneOffIconSvg)
export const PlayIcon = /* @__PURE__ */ createIcon(PlayIconSvg)
export const PlugIcon = /* @__PURE__ */ createIcon(PlugIconSvg)
export const PlugZap = /* @__PURE__ */ createIcon(PlugZapSvg)
export const PlusIcon = /* @__PURE__ */ createIcon(PlusIconSvg)
export const PowerIcon = /* @__PURE__ */ createIcon(PowerIconSvg)
export const RefreshCwIcon = /* @__PURE__ */ createIcon(RefreshCwIconSvg)
export const RotateCcwIcon = /* @__PURE__ */ createIcon(RotateCcwIconSvg)
export const ScrollTextIcon = /* @__PURE__ */ createIcon(ScrollTextIconSvg)
export const SearchIcon = /* @__PURE__ */ createIcon(SearchIconSvg)
export const SendHorizonalIcon = /* @__PURE__ */ createIcon(SentIconSvg)
export const SendIcon = /* @__PURE__ */ createIcon(SendIconSvg)
export const ServerIcon = /* @__PURE__ */ createIcon(ServerIconSvg)
export const SettingsIcon = /* @__PURE__ */ createIcon(SettingsIconSvg)
export const ShieldAlertIcon = /* @__PURE__ */ createIcon(ShieldAlertIconSvg)
export const SignalHighIcon = /* @__PURE__ */ createIcon(SignalHighIconSvg)
export const SignalLowIcon = /* @__PURE__ */ createIcon(SignalLowIconSvg)
export const SignalMediumIcon = /* @__PURE__ */ createIcon(SignalMediumIconSvg)
export const SlidersHorizontalIcon = /* @__PURE__ */ createIcon(SlidersHorizontalIconSvg)
export const SmilePlusIcon = /* @__PURE__ */ createIcon(SmilePlusIconSvg)
export const SparklesIcon = /* @__PURE__ */ createIcon(SparklesIconSvg)
export const SquareCodeIcon = /* @__PURE__ */ createIcon(CodeSquareIconSvg)
export const SquareIcon = /* @__PURE__ */ createIcon(SquareIconSvg)
export const SquareKanbanIcon = /* @__PURE__ */ createIcon(SquareKanbanIconSvg)
export const SquarePenIcon = /* @__PURE__ */ createIcon(SquarePenIconSvg)
export const StarIcon = /* @__PURE__ */ createIcon(StarIconSvg)
export const StickyNoteIcon = /* @__PURE__ */ createIcon(StickyNoteIconSvg)
export const StrikethroughIcon = /* @__PURE__ */ createIcon(StrikethroughIconSvg)
export const SunIcon = /* @__PURE__ */ createIcon(SunIconSvg)
export const TagIcon = /* @__PURE__ */ createIcon(TagIconSvg)
export const TerminalIcon = /* @__PURE__ */ createIcon(TerminalIconSvg)
export const TextQuoteIcon = /* @__PURE__ */ createIcon(TextQuoteIconSvg)
export const TimerIcon = /* @__PURE__ */ createIcon(TimerIconSvg)
export const Trash2Icon = /* @__PURE__ */ createIcon(Delete02IconSvg)
export const TrashIcon = /* @__PURE__ */ createIcon(TrashIconSvg)
export const TriangleAlertIcon = /* @__PURE__ */ createIcon(TriangleAlertIconSvg)
export const UndoIcon = /* @__PURE__ */ createIcon(UndoIconSvg)
export const UnplugIcon = /* @__PURE__ */ createIcon(UnplugIconSvg)
export const UploadIcon = /* @__PURE__ */ createIcon(UploadIconSvg)
export const UserIcon = /* @__PURE__ */ createIcon(UserIconSvg)
export const UserMinusIcon = /* @__PURE__ */ createIcon(UserMinusIconSvg)
export const UserPlusIcon = /* @__PURE__ */ createIcon(UserPlusIconSvg)
export const UsersIcon = /* @__PURE__ */ createIcon(UsersIconSvg)
export const VideoIcon = /* @__PURE__ */ createIcon(VideoIconSvg)
export const VideoOffIcon = /* @__PURE__ */ createIcon(VideoOffIconSvg)
export const Volume2Icon = /* @__PURE__ */ createIcon(VolumeHighIconSvg)
export const XIcon = /* @__PURE__ */ createIcon(XIconSvg)
