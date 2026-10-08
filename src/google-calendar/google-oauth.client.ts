import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

export type GoogleUserInfo = {
  email?: string;
  name?: string;
  sub?: string;
};

export type GoogleCalendarListItem = {
  id: string;
  summary: string;
  primary?: boolean;
  selected?: boolean;
  deleted?: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole?: string;
};

export type GoogleCalendarEventRaw = {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
};

@Injectable()
export class GoogleOAuthClient {
  private readonly logger = new Logger(GoogleOAuthClient.name);

  constructor(private readonly config: ConfigService) {}

  private clientId(): string {
    const v = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    if (!v) throw new BadRequestException('GOOGLE_CLIENT_ID belum dikonfigurasi');
    return v;
  }

  private clientSecret(): string {
    const v = this.config.get<string>('GOOGLE_CLIENT_SECRET')?.trim();
    if (!v) throw new BadRequestException('GOOGLE_CLIENT_SECRET belum dikonfigurasi');
    return v;
  }

  redirectUri(): string {
    const v = this.config.get<string>('GOOGLE_REDIRECT_URI')?.trim();
    if (!v) {
      throw new BadRequestException('GOOGLE_REDIRECT_URI belum dikonfigurasi');
    }
    return v;
  }

  isConfigured(): boolean {
    return !!(
      this.config.get<string>('GOOGLE_CLIENT_ID')?.trim() &&
      this.config.get<string>('GOOGLE_CLIENT_SECRET')?.trim() &&
      this.config.get<string>('GOOGLE_REDIRECT_URI')?.trim()
    );
  }

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId(),
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: GOOGLE_CALENDAR_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<GoogleTokenResponse> {
    try {
      const { data } = await axios.post<GoogleTokenResponse>(
        TOKEN_URL,
        new URLSearchParams({
          code,
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          redirect_uri: this.redirectUri(),
          grant_type: 'authorization_code',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20_000 },
      );
      if (!data?.access_token) {
        throw new BadRequestException('Google tidak mengembalikan access_token');
      }
      return data;
    } catch (e) {
      this.logger.warn(`exchangeCode failed: ${String(e)}`);
      throw new BadRequestException('Gagal menukar kode OAuth Google');
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    try {
      const { data } = await axios.post<GoogleTokenResponse>(
        TOKEN_URL,
        new URLSearchParams({
          refresh_token: refreshToken,
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          grant_type: 'refresh_token',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20_000 },
      );
      if (!data?.access_token) {
        throw new BadRequestException('Google refresh gagal');
      }
      return data;
    } catch (e) {
      this.logger.warn(`refreshAccessToken failed: ${String(e)}`);
      throw new BadRequestException('Sesi Google Calendar kedaluwarsa — hubungkan ulang');
    }
  }

  async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const { data } = await axios.get<GoogleUserInfo>(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15_000,
    });
    return data;
  }

  async listCalendars(accessToken: string): Promise<GoogleCalendarListItem[]> {
    const items: GoogleCalendarListItem[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await axios.get<{
        items?: GoogleCalendarListItem[];
        nextPageToken?: string;
      }>(`${CALENDAR_API}/users/me/calendarList`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { maxResults: 250, pageToken },
        timeout: 20_000,
      });
      for (const it of data.items || []) {
        if (it?.id) items.push(it);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return items;
  }


  async createEvent(
    accessToken: string,
    calendarId: string,
    body: Record<string, unknown>,
  ): Promise<GoogleCalendarEventRaw> {
    try {
      const { data } = await axios.post<GoogleCalendarEventRaw>(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        body,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 20_000,
        },
      );
      return data;
    } catch (e) {
      throw new BadRequestException(this.googleApiError(e, 'Gagal membuat event Google'));
    }
  }

  async updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
  ): Promise<GoogleCalendarEventRaw> {
    const { data } = await axios.patch<GoogleCalendarEventRaw>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      body,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 20_000,
      },
    );
    return data;
  }

  async deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
  ): Promise<void> {
    await axios.delete(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 20_000,
      },
    );
  }

  async listEvents(
    accessToken: string,
    calendarId: string,
    timeMinIso: string,
    timeMaxIso: string,
  ): Promise<GoogleCalendarEventRaw[]> {
    const events: GoogleCalendarEventRaw[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const { data } = await axios.get<{
          items?: GoogleCalendarEventRaw[];
          nextPageToken?: string;
        }>(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            timeMin: timeMinIso,
            timeMax: timeMaxIso,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 2500,
            pageToken,
          },
          timeout: 25_000,
        });
        for (const it of data.items || []) {
          if (it?.status === 'cancelled') continue;
          events.push(it);
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    } catch (e) {
      throw new BadRequestException(this.googleApiError(e, 'Gagal memuat event Google'));
    }
    return events;
  }

  private googleApiError(e: unknown, fallback: string): string {
    const ax = e as {
      response?: { status?: number; data?: { error?: { message?: string; status?: string } } };
      message?: string;
    };
    const apiMsg = ax.response?.data?.error?.message;
    const status = ax.response?.status;
    if (apiMsg) return status ? `${fallback} (${status}: ${apiMsg})` : `${fallback}: ${apiMsg}`;
    return ax.message || fallback;
  }
}
